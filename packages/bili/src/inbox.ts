// 回复我的 / @我的。移植自 upstream/tools/lib/msgfeed.mjs 与 commands/comment-digest.mjs。
import { biliGet, isFatalBiliError } from './api.js'
import type { BiliContext } from './context.js'
import { updateFeedback } from './feedback.js'
import { isId, isObject } from './write.js'

export type InboxItem = { id: string; kind: 'reply' | 'at'; from: 'owner' | 'other'; mid: string; uname: string; text: string; bvid?: string; oid: string; root: string; parent: string; type: number; at: number }
type FeedRow = {
  id?: string | number; reply_time?: number; at_time?: number; user?: { mid?: string | number; nickname?: string }
  item?: { business_id?: number; subject_id?: string | number; root_id?: string | number; source_id?: string | number; uri?: string }
}
type FeedPage = { items?: FeedRow[]; cursor?: string | { id?: string | number; time?: number; is_end?: boolean } }
type Reply = { rpid?: string | number; rpid_str?: string; mid?: string | number; member?: { mid?: string | number; uname?: string }; parent?: string | number; parent_str?: string; ctime?: number; content?: { message?: string } }
type Candidate = Omit<InboxItem, 'from' | 'text'>
const rpidOf = (row: Reply) => String(row.rpid_str ?? row.rpid ?? '')
const midOf = (row: Reply) => String(row.mid ?? row.member?.mid ?? '')

async function feedRows(ctx: BiliContext, kind: InboxItem['kind'], pages: number): Promise<Candidate[]> {
  const rows: Candidate[] = []
  const cursors = new Set<string>()
  let next = new URLSearchParams()
  for (let page = 0; page < pages; page++) {
    const result = await biliGet<FeedPage>(ctx, `https://api.bilibili.com/x/msgfeed/${kind}?platform=web&build=0&mobi_app=web&${next}`)
    if (result.code !== 0 || !Array.isArray(result.data?.items)) throw new Error(`收件箱读取失败（${kind}，code=${result.code}），请稍后重试`)
    for (const raw of result.data.items) {
      if (!isObject(raw)) continue
      const id = String(raw.id ?? ''), mid = String(raw.user?.mid ?? '')
      const oid = String(raw.item?.subject_id ?? ''), parent = String(raw.item?.source_id ?? '')
      const root = String(raw.item?.root_id ?? '0')
      const at = Number(raw.reply_time ?? raw.at_time) * 1000
      const type = Number(raw.item?.business_id ?? 1)
      if (!isId(id) || !isId(mid) || !isId(oid) || !isId(parent) || (root !== '0' && !isId(root))
        || !Number.isFinite(at) || at <= 0 || ![1, 11, 17].includes(type)) continue
      const bvid = type === 1 ? String(raw.item?.uri ?? '').match(/\bBV[0-9A-Za-z]{10}\b/)?.[0] : undefined
      rows.push({ id, kind, mid, oid, parent, root: root === '0' ? parent : root, type, at, uname: String(raw.user?.nickname ?? '匿名'), ...(bvid ? { bvid } : {}) })
    }
    const cursor = result.data.cursor
    if (!result.data.items.length || !cursor) break
    if (typeof cursor === 'string') next = new URLSearchParams({ cursor })
    else {
      if (cursor.is_end) break
      if (!isId(String(cursor.id ?? '')) || !Number.isFinite(cursor.time)) throw new Error('收件箱分页游标无效')
      next = new URLSearchParams({ id: String(cursor.id), [`${kind}_time`]: String(cursor.time) })
    }
    if (cursors.has(next.toString())) throw new Error('收件箱分页未前进，请稍后重试')
    cursors.add(next.toString())
  }
  return rows
}

async function threadRows(ctx: BiliContext, item: Candidate): Promise<Reply[] | null> {
  const all: Reply[] = []
  for (let pn = 1; pn <= 6; pn++) {
    const result = await biliGet<{ root?: Reply; replies?: Reply[] | null }>(ctx,
      `https://api.bilibili.com/x/v2/reply/reply?type=${item.type}&oid=${item.oid}&root=${item.root}&ps=20&pn=${pn}`)
    if (result.code !== 0) return null
    if (pn === 1 && result.data?.root) all.push(result.data.root)
    const replies = result.data?.replies ?? []
    if (!Array.isArray(replies)) return null
    all.push(...replies)
    if (replies.length < 20) break
  }
  return all
}

/** 所有正文都回读楼层；取不到或坐标/作者对不上时跳过，不使用通知里的 title/source_content。at 为毫秒。 */
export async function pullInbox(ctx: BiliContext, opt: { sinceMs: number; pages?: number }): Promise<InboxItem[]> {
  const pages = opt.pages ?? 2
  if (!Number.isFinite(opt.sinceMs) || opt.sinceMs < 0 || !Number.isInteger(pages) || pages < 1 || pages > 10) throw new Error('收件箱需要有效的起始时间和 1–10 页')
  const all = [...await feedRows(ctx, 'reply', pages), ...await feedRows(ctx, 'at', pages)]
  const seen = new Set<string>()
  const candidates = all.filter((row) => {
    const key = `${row.kind}:${row.id}`
    if (seen.has(key) || row.at < opt.sinceMs || row.at > ctx.now() || row.mid === ctx.settings.self.mid) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.at - b.at).slice(0, 20)
  const threads = new Map<string, Reply[] | null>()
  const items: InboxItem[] = []
  for (const row of candidates) {
    const key = `${row.type}:${row.oid}:${row.root}`
    if (!threads.has(key)) {
      try { threads.set(key, await threadRows(ctx, row)) } catch (e) {
        if (isFatalBiliError(e)) throw e
        threads.set(key, null)
      }
    }
    const replies = threads.get(key) ?? []
    // 优先匹配确切 rpid；只有作者、父评论和通知时间都匹配时才使用父评论退路。
    const mine = replies.filter((r) => isObject(r) && midOf(r) === row.mid)
    const hit = mine.find((r) => rpidOf(r) === row.parent)
      ?? mine.find((r) => String(r.parent_str ?? r.parent ?? '') === row.parent && Number(r.ctime) * 1000 === row.at)
    const at = Number(hit?.ctime) * 1000
    if (!hit || !isId(rpidOf(hit)) || typeof hit.content?.message !== 'string' || !Number.isFinite(at) || at < opt.sinceMs || at > ctx.now()) continue
    items.push({ ...row, parent: rpidOf(hit), from: row.mid === ctx.settings.owner.mid ? 'owner' : 'other', text: hit.content.message, at, uname: String(hit.member?.uname ?? row.uname) })
  }
  updateFeedback(ctx.dataDir, Math.max(0, ...items.filter((item) => item.from === 'owner').map((item) => item.at)), ctx.now())
  return items.sort((a, b) => a.at - b.at)
}

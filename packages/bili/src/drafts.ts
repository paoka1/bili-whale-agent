// 待审回复。移植自 upstream/tools/commands/reply-draft.mjs；只有审批入口可发送给陌生人。
import { randomBytes } from 'node:crypto'
import { publishComment, readReply } from './comment.js'
import type { BiliContext } from './context.js'
import { dataPath } from './paths.js'
import { readQuota } from './quota.js'
import { writeJsonAtomic } from './store.js'
import { getVideo } from './video.js'
import { dryPreview, isBvid, isId, isObject, readState, refuse, validAt, writeAction, type WriteResult } from './write.js'

export type Draft = { id: string; bvid: string; oid: string; root: string; parent: string; who: string; src: string; message: string; at: string }
type DraftStore = { items: Draft[]; rejected?: (Draft & { reason: string; rejectedAt: string })[] }
const approving = new Set<string>()
const keyOf = (dataDir: string, id: string) => dataPath(dataDir, 'pending-replies.json') + ':' + id

function load(dataDir: string): DraftStore {
  const db = readState<unknown>(dataDir, 'pending-replies.json', { items: [] })
  if (!isObject(db) || !Array.isArray(db.items) || !db.items.every((d) => isObject(d)
    && typeof d.id === 'string' && isBvid(d.bvid) && isId(d.oid) && isId(d.parent) && (isId(d.root) || d.root === '0')
    && typeof d.message === 'string' && !!d.message.trim() && d.message.length <= 500
    && typeof d.who === 'string' && typeof d.src === 'string' && validAt(d.at))) return refuse('pending-replies.json 草稿队列损坏，停止操作')
  if (db.rejected !== undefined && !Array.isArray(db.rejected)) return refuse('草稿拒绝记录损坏，停止操作')
  if (new Set(db.items.map((d: Draft) => d.id)).size !== db.items.length) return refuse('草稿 ID 重复，停止操作')
  return db as DraftStore
}

export const listDrafts = (dataDir: string): Draft[] => load(dataDir).items

export function addDraft(ctx: BiliContext, d: Omit<Draft, 'id' | 'at'>): Draft {
  if (!isBvid(d.bvid) || !isId(d.oid) || !isId(d.parent) || (!isId(d.root) && d.root !== '0')) return refuse('草稿需要有效的 BV 号和回复坐标')
  if (typeof d.message !== 'string' || !d.message.trim() || d.message.trim().length > 500) return refuse('草稿正文需要 1–500 字')
  const db = load(ctx.dataDir)
  const old = db.items.find((row) => row.oid === d.oid && row.parent === d.parent)
  if (old) return old // 同一 parent 不重复入队，也不偷偷替换主人正在审核的正文。
  const item: Draft = { ...d, root: d.root === '0' ? d.parent : d.root, message: d.message.trim(), who: String(d.who ?? ''), src: String(d.src ?? '').slice(0, 300), id: randomBytes(4).toString('hex'), at: new Date(ctx.now()).toISOString() }
  db.items.push(item)
  writeJsonAtomic(dataPath(ctx.dataDir, 'pending-replies.json'), db)
  return item
}

export async function approveDraft(ctx: BiliContext, id: string): Promise<WriteResult> {
  return writeAction(ctx, async () => {
    const d = load(ctx.dataDir).items.find((row) => row.id === id)
    if (!d) return refuse('没有这条待审草稿')
    const key = keyOf(ctx.dataDir, id)
    approving.add(key)
    try {
      readQuota(ctx.dataDir)
      const meta = await getVideo(ctx, d.bvid)
      if (!Number.isSafeInteger(meta.aid) || meta.aid <= 0 || String(meta.aid) !== d.oid) return refuse('草稿视频与 oid 不一致，停止发送')
      const root = d.root === '0' ? d.parent : d.root
      if (!await readReply(ctx, d.oid, root, d.parent)) return refuse('被回复的评论不存在或无法核实，草稿保留')
      if (ctx.dryRun) return dryPreview(ctx, `BV:${d.bvid}`, d.message)
      return await publishComment(ctx, { ...d, root }, () => {
        // 成功后再删；重新读队列，保留等待网络期间新增的草稿。失败或演练时一直留在队列中。
        const current = load(ctx.dataDir)
        current.items = current.items.filter((row) => row.id !== id)
        writeJsonAtomic(dataPath(ctx.dataDir, 'pending-replies.json'), current)
      })
    } finally { approving.delete(key) }
  })
}

export function rejectDraft(dataDir: string, id: string, reason = ''): void {
  if (approving.has(keyOf(dataDir, id))) return refuse('这条草稿正在发送，请等待处理结果')
  const db = load(dataDir)
  const d = db.items.find((row) => row.id === id)
  if (!d) return refuse('没有这条待审草稿')
  db.items = db.items.filter((row) => row.id !== id)
  db.rejected = [...(db.rejected ?? []), { ...d, reason: reason.slice(0, 500), rejectedAt: new Date().toISOString() }].slice(-200)
  writeJsonAtomic(dataPath(dataDir, 'pending-replies.json'), db)
}

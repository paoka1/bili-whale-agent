// 主人私信历史。移植自 upstream/tools/lib/dm-history.mjs，使用精确序号游标。
import path from 'node:path'
import { biliGet, parseJsonExact } from './api.js'
import type { BiliContext } from './context.js'
import { updateFeedback } from './feedback.js'
import { dataPath } from './paths.js'
import { writeJsonAtomic } from './store.js'
import { isId, isObject, readState } from './write.js'

export type OwnerDmState = { baseline: boolean; lastSeq: string | null }
export type OwnerDmResult = { messages: { id: string; text: string; at: number }[]; state: OwnerDmState }
type Message = { seq: string; id: string; sender: string; at: number; type: number; text: string; withdrawn: string | null }
const isSeq = (value: unknown): value is string => typeof value === 'string' && /^\d{1,32}$/.test(value)
const pending = new Map<string, Promise<void>>()

function stateOf(value: unknown): OwnerDmState {
  if (!isObject(value) || typeof value.baseline !== 'boolean' || (value.lastSeq !== null && !isSeq(value.lastSeq))
    || (!value.baseline && value.lastSeq !== null)) throw new Error('主人私信游标损坏，保留已读位置，请先检查状态')
  return { baseline: value.baseline, lastSeq: value.lastSeq }
}

function normalize(raw: unknown): Message {
  if (!isObject(raw)) throw new Error('私信历史消息格式无效，保留游标')
  const seq = String(raw.msg_seqno ?? ''), sender = String(raw.sender_uid ?? '')
  const at = Number(raw.timestamp) * 1000
  const type = Number(raw.msg_type ?? 1)
  const id = String(raw.msg_key_str ?? raw.msg_key ?? seq)
  if (!isSeq(seq) || !isId(sender) || !id || !Number.isFinite(at) || at < 0 || !Number.isInteger(type)) throw new Error('私信历史缺少有效的序号、时间或发送者，保留游标')
  let content: unknown = raw.content
  if (typeof content === 'string') {
    try { content = parseJsonExact(content) } catch { /* 兼容纯文本消息；撤回正文中的大整数 ID 也要保留精度 */ }
  }
  const text = isObject(content) ? content.content ?? content.text : content
  const withdrawn = type === 5 ? String(isObject(content) ? content.msg_key_str ?? content.msg_key ?? '' : content ?? '') : null
  if (type === 1 && typeof text !== 'string') throw new Error('私信文本格式无效，保留游标')
  return { seq, id, sender, at, type, text: typeof text === 'string' ? text : '', withdrawn }
}

async function pullOnce(ctx: BiliContext, supplied: OwnerDmState): Promise<OwnerDmResult> {
  const owner = ctx.settings.owner.mid
  if (!isId(owner)) throw new Error('读取主人私信需要先配置主人 mid')
  let state = stateOf(supplied)
  const saved = readState<unknown>(ctx.dataDir, 'owner-dm-state.json', undefined)
  if (saved !== undefined) {
    const previous = stateOf(saved)
    const record = saved as Record<string, unknown>
    if ((record.owner !== undefined && record.owner !== owner) || (record.self !== undefined && record.self !== ctx.settings.self.mid)) {
      state = { baseline: false, lastSeq: null }
    } else if (previous.baseline && (!state.baseline || (previous.lastSeq !== null && (state.lastSeq === null || BigInt(previous.lastSeq) > BigInt(state.lastSeq))))) {
      state = previous
    }
  }
  const all = new Map<string, Message>()
  let cursor = '0'
  const boundary = state.lastSeq === null ? null : BigInt(state.lastSeq)
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ talker_id: owner, session_type: '1', size: '30', begin_seqno: cursor })
    const result = await biliGet<{ messages?: unknown[]; has_more?: number | string | boolean }>(ctx,
      `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?${query}`, { wbi: true })
    // 2026-10-29 真机实测：从没聊过时返回 code 0 + messages: null，是空会话不是失败
    const raw = result.data?.messages ?? (result.code === 0 ? [] : undefined)
    if (result.code !== 0 || !Array.isArray(raw)) throw new Error(`主人私信读取失败（code=${result.code}），保留游标`)
    const rows = raw.map(normalize)
    for (const row of rows) {
      const previous = all.get(row.seq)
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('私信重叠分页内容不一致，保留游标')
      all.set(row.seq, row)
    }
    // 首次只检查最新一页，不回放历史；之后必须翻到已读边界，不能被自己最近发出的消息遮住。
    const more = result.data?.has_more
    if (!state.baseline || (boundary !== null && rows.some((r) => BigInt(r.seq) <= boundary))
      || more === 0 || more === '0' || more === false || (more === undefined && rows.length < 30)) break
    if (more !== undefined && more !== 1 && more !== '1' && more !== true) throw new Error('私信分页状态无效，保留游标')
    if (!rows.length) throw new Error('私信分页没有前进，保留游标')
    const next = rows.reduce((min, row) => BigInt(row.seq) < BigInt(min) ? row.seq : min, rows[0]!.seq)
    if (next === cursor || (cursor !== '0' && BigInt(next) >= BigInt(cursor))) throw new Error('私信分页没有前进，保留游标')
    if (page === 9) throw new Error('私信积压超过单次 10 页，保留游标，请人工检查')
    cursor = next
  }
  const rows = [...all.values()].sort((a, b) => a.at - b.at || (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0))
  const withdrawn = new Set(rows.filter((r) => r.type === 5).map((r) => r.withdrawn))
  const messages = state.baseline ? rows.filter((r) => (boundary === null || BigInt(r.seq) > boundary)
    // 不按本机时间过滤：游标会越过这批消息，服务器时钟慢几秒就会把主人刚发的私信永久跳过
    && r.sender === owner && r.type === 1 && r.text.trim() && !withdrawn.has(r.id))
    .map((r) => ({ id: r.id, text: r.text, at: r.at })) : []
  const lastSeq = rows.reduce<string | null>((max, row) => max === null || BigInt(row.seq) > BigInt(max) ? row.seq : max, state.lastSeq)
  const next = { baseline: true, lastSeq }
  // 反馈先保存；若本地写入失败，不推进游标，下一轮仍能重试这批消息。
  updateFeedback(ctx.dataDir, Math.max(0, ...messages.map((message) => message.at)), ctx.now())
  writeJsonAtomic(dataPath(ctx.dataDir, 'owner-dm-state.json'), { ...next, owner, self: ctx.settings.self.mid })
  return { messages, state: next }
}

/** at 使用毫秒。相同数据目录串行读取并合并持久化游标，重启后不会重放已读消息。 */
export async function pullOwnerDms(ctx: BiliContext, state: OwnerDmState): Promise<OwnerDmResult> {
  const key = path.resolve(ctx.dataDir)
  const before = pending.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => { release = resolve })
  pending.set(key, done)
  await before
  try { return await pullOnce(ctx, state) } finally {
    if (pending.get(key) === done) pending.delete(key)
    release()
  }
}

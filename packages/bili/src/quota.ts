// 评论与私信共享分享额度。移植自 upstream/tools/commands/quota.mjs 与 lib/share-policy.mjs。
import type { BiliContext } from './context.js'
import { dataPath } from './paths.js'
import { readJson, writeJsonAtomic } from './store.js'
import { DAY_MS, isBvid, isObject, localDay, readState, refuse, validAt, WriteRefusedError } from './write.js'

export type { WriteResult } from './write.js'
export type ShareOptions = { bvid: string; reason: string; score: number; rank: number }
export type WriteRecord = { type: 'comment' | 'dm' | 'fav'; target: string; note: string; auto: boolean; share: boolean }
export type QuotaEntry = { at: string; type: string; target: string | null; note?: string | null; auto?: boolean; share?: boolean }

export function readQuota(dataDir: string): QuotaEntry[] {
  const db = readState<unknown>(dataDir, 'quota.json', { log: [] })
  if (!isObject(db) || !Array.isArray(db.log) || !db.log.every((row) => isObject(row)
    && validAt(row.at) && typeof row.type === 'string' && (row.target === null || typeof row.target === 'string')
    && (row.share === undefined || typeof row.share === 'boolean') && (row.auto === undefined || typeof row.auto === 'boolean'))) {
    return refuse('quota.json 额度账本损坏，停止写入')
  }
  return db.log as QuotaEntry[]
}

const targetOf = (target: string) => target.startsWith('BV:') ? target.slice(3) : target

/** 无反馈时从第一次分享计时；3 天开始衰减，到第 7 天停止，沿用上游算法。 */
function shareCap(ctx: BiliContext, log: QuotaEntry[]): number {
  const cap = ctx.settings.quota.shareDaily
  const after = ctx.settings.share.silentAfterDays
  if (!Number.isInteger(cap) || cap < 0 || !Number.isFinite(after) || after < 0) return refuse('分享额度配置无效')
  const feedback = readJson<{ last?: string }>(dataPath(ctx.dataDir, 'feedback.json'), {})
  const first = log.filter((row) => row.share).map((row) => Date.parse(row.at)).sort((a, b) => a - b)[0]
  const base = validAt(feedback?.last) ? Date.parse(feedback.last) : first
  const days = base === undefined ? 0 : Math.max(0, Math.floor((ctx.now() - base) / DAY_MS))
  const stopAt = Math.max(after + 1, 7)
  if (days < after) return cap
  if (days >= stopAt) return 0
  return Math.min(cap, Math.max(1, Math.floor(cap * (stopAt - days) / (stopAt - after))))
}

export function checkShare(ctx: BiliContext, opt: ShareOptions): { ok: true } | { ok: false; reason: string } {
  try {
    if (ctx.settings.share.enabled === false) return refuse('分享已关闭')
    if (!isBvid(opt.bvid)) return refuse('分享需要有效的 BV 号')
    if (typeof opt.reason !== 'string' || opt.reason.trim().length < 8) return refuse('分享理由至少需要 8 字')
    if (typeof opt.score !== 'number' || !Number.isFinite(opt.score) || opt.score < 0 || opt.score > 20) return refuse('分享评分必须是 0–20 的数字')
    const threshold = ctx.settings.share.minScore
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 20 || opt.score < threshold) return refuse('分享评分未达到配置的最低分')
    if (opt.rank !== 1) return refuse('分享只允许 rank 为 1 的视频')
    const log = readQuota(ctx.dataDir)
    const cap = shareCap(ctx, log)
    // 2026-10-18 上游修复：UTC ISO 时间必须先转本地日期，不能直接 startsWith(today)。
    const used = log.filter((row) => row.share && localDay(row.at) === localDay(ctx.now())).length
    if (used >= cap) return refuse(`今日分享额度已用完（有效上限 ${cap}）`)
    if (log.some((row) => row.share && targetOf(row.target ?? '') === opt.bvid && ctx.now() - Date.parse(row.at) < 7 * DAY_MS)) {
      return refuse('同一视频 7 天内只能分享一次')
    }
    return { ok: true }
  } catch (e) {
    if (e instanceof WriteRefusedError) return { ok: false, reason: e.message }
    throw e
  }
}

/** 只记录实际发送成功的动作；配置始终来自 ctx，不读取旧账本中的 daily/shareDaily。 */
export function recordWrite(ctx: BiliContext, row: WriteRecord): void {
  const log = readQuota(ctx.dataDir)
  const target = isBvid(row.target) ? `BV:${row.target}` : row.target
  log.push({ at: new Date(ctx.now()).toISOString(), ...row, target, note: row.note.replace(/\s+/g, ' ').slice(0, 40) })
  writeJsonAtomic(dataPath(ctx.dataDir, 'quota.json'), { log })
}

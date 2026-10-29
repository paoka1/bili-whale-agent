// 两本日记与事件流。沿用上游 tools/commands/diary.mjs 的文件名和日志格式。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { dataPath } from './paths.js'
import { appendJsonl, readJsonl } from './store.js'
import { isObject, validAt } from './write.js'

export type LogEntry = { at: string; kind: string; target: string | null; note: string }
const DIARIES = { public: 'whale-diary.md', private: 'whale-diary-private.md' } as const
const MAX_DIARY_BYTES = 200 * 1024

export function readDiaries(dataDir: string): { public: string; private: string } {
  const read = (which: keyof typeof DIARIES) => {
    try { return fs.readFileSync(dataPath(dataDir, DIARIES[which]), 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new Error('日记读取失败，请检查数据目录')
    }
  }
  return { public: read('public'), private: read('private') }
}

/** 整篇原子覆盖，按 UTF-8 字节而不是 JS 字符数限制大小。 */
export function writeDiary(dataDir: string, which: 'public' | 'private', markdown: string): void {
  if (which !== 'public' && which !== 'private') throw new Error('只能写公开或私人日记')
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_DIARY_BYTES) throw new Error('日记必须是文本，且不能超过 200KB')
  fs.mkdirSync(dataDir, { recursive: true })
  const file = dataPath(dataDir, DIARIES[which])
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, markdown, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

export function appendLog(dataDir: string, e: Omit<LogEntry, 'at'>): void {
  if (typeof e.kind !== 'string' || !e.kind.trim() || typeof e.note !== 'string' || (e.target !== null && typeof e.target !== 'string')) throw new Error('活动记录格式无效')
  appendJsonl(dataPath(dataDir, 'whale-log.jsonl'), { at: new Date().toISOString(), kind: e.kind, target: e.target, note: e.note })
}

/** 最新在后；先跳过损坏记录，再取最近 N 条。 */
export function readLog(dataDir: string, limit?: number): LogEntry[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('活动记录条数必须是非负整数')
  if (limit === 0) return []
  const rows = readJsonl<unknown>(dataPath(dataDir, 'whale-log.jsonl')).filter((e): e is LogEntry => isObject(e)
    && validAt(e.at) && typeof e.kind === 'string' && typeof e.note === 'string' && (e.target === null || typeof e.target === 'string'))
  return limit === undefined ? rows : rows.slice(-limit)
}

// 两本日记与事件流。沿用上游 tools/commands/diary.mjs 的文件名和日志格式。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { dataPath } from './paths.js'
import { appendJsonl, readJsonl } from './store.js'
import { isObject, validAt } from './write.js'
import { scanDiary, parseDiary, sortEntries, type DiaryWhich, type DiaryEntry } from './diary-entries.js'

export type LogEntry = { at: string; kind: string; target: string | null; note: string }
const DIARIES = { public: 'whale-diary.md', private: 'whale-diary-private.md' } as const
const MAX_DIARY_BYTES = 200 * 1024
export const MEMORY_MAX_CHARS = 3000
export const APPEND_MAX_BYTES = 20 * 1024
export const RECENT_DAYS = 3
export const CATALOG_LIMIT = 100
export const SEARCH_LIMIT = 10

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

/** 只追加本轮正文；读取旧文仅用于条目编号与补换行，不覆盖原文件。 */
export function appendDiary(dataDir: string, which: DiaryWhich, markdown: string, now: number): { entry: string } {
  if (!markdown.trim()) throw new Error('日记正文不能为空')
  if (Buffer.byteLength(markdown, 'utf8') > APPEND_MAX_BYTES) throw new Error('单次日记正文不能超过 20KB')
  const body = scanDiary(markdown)
  if (body.headings.length) throw new Error('日记正文不能带一级或二级标题，请改用 ### 小节')
  if (body.openFence) throw new Error('日记正文的代码围栏必须闭合，以免吞掉下一篇标题')
  const file = dataPath(dataDir, DIARIES[which])
  let previous = ''
  try { previous = fs.readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('日记读取失败，请检查数据目录')
  }
  if (scanDiary(previous).openFence) throw new Error('旧日记末尾有未闭合的代码围栏，请先修复后再追加')
  const date = new Date(now)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const separator = !previous || previous.endsWith('\n\n') ? '' : previous.endsWith('\n') ? '\n' : '\n\n'
  const entry = `${which}:${parseDiary(which, previous).length}`
  fs.mkdirSync(dataDir, { recursive: true })
  fs.appendFileSync(file, `${separator}## ${date.toLocaleDateString('sv-SE')} · ${time}\n\n${markdown}\n`, { mode: 0o600 })
  return { entry }
}

export function readMemory(dataDir: string): string {
  try { return fs.readFileSync(dataPath(dataDir, 'whale-memory.md'), 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error('长期记忆读取失败，请检查数据目录')
  }
}

export function writeMemory(dataDir: string, markdown: string): void {
  if (Array.from(markdown).length > MEMORY_MAX_CHARS) throw new Error('长期记忆不能超过 3000 字，请先压缩结论')
  fs.mkdirSync(dataDir, { recursive: true })
  const file = dataPath(dataDir, 'whale-memory.md')
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, markdown, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

export function listEntries(dataDir: string): DiaryEntry[] {
  const diaries = readDiaries(dataDir)
  return sortEntries([...parseDiary('public', diaries.public), ...parseDiary('private', diaries.private)])
}

export function readDiarySnapshot(dataDir: string, now: number) {
  const entries = listEntries(dataDir)
  const date = new Date(now)
  const today = date.toLocaleDateString('sv-SE')
  date.setDate(date.getDate() - RECENT_DAYS + 1)
  const since = date.toLocaleDateString('sv-SE')
  return {
    memory: readMemory(dataDir),
    recent: entries.filter((e) => e.date !== null && e.date >= since && e.date <= today),
    catalog: entries.slice(0, CATALOG_LIMIT).map((e) => ({ entry: e.id, which: e.which, date: e.date,
      title: e.title, bvids: e.bvids.slice(0, 5), moreBvids: Math.max(0, e.bvids.length - 5) })),
    total: entries.length, today, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

export function readDiaryEntry(dataDir: string, id: string): DiaryEntry | null {
  return listEntries(dataDir).find((e) => e.id === id) ?? null
}

export function searchDiaries(dataDir: string, query: string, which?: DiaryWhich) {
  const needle = query.toLowerCase()
  const matches = listEntries(dataDir).filter((e) => (!which || e.which === which)
    && `${e.title}\n${e.markdown}\n${e.date ?? ''}`.toLowerCase().includes(needle))
  return { total: matches.length, hits: matches.slice(0, SEARCH_LIMIT).map((e) => {
    // 先在原文按码点定位，大小写转换改变 UTF-16 长度时也不切断表情。
    const chars = Array.from(e.markdown)
    const folded = chars.map((char) => char.toLowerCase())
    const position = folded.join('').indexOf(needle)
    let index = 0, length = 0
    while (index < folded.length && length < position) length += folded[index++]!.length
    const start = Math.max(0, index - 100)
    return { entry: e.id, which: e.which, date: e.date, title: e.title, excerpt: chars.slice(start, start + 300).join('') }
  }) }
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

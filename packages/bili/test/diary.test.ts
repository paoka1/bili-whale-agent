import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  appendDiary, appendLog, listEntries, readDiaries, readDiaryEntry, readDiarySnapshot,
  readLog, readMemory, searchDiaries, writeDiary, writeMemory,
} from '../src/diary.js'
import { fakeBili } from './helpers.js'

it('日记分别整篇覆盖，空目录返回空文本', () => {
  const { dataDir } = fakeBili(() => undefined)
  expect(readDiaries(dataDir)).toEqual({ public: '', private: '' })
  writeDiary(dataDir, 'public', '公开日记')
  writeDiary(dataDir, 'private', '私人日记')
  writeDiary(dataDir, 'public', '新版公开日记')
  expect(readDiaries(dataDir)).toEqual({ public: '新版公开日记', private: '私人日记' })
})

it('日记超过 200KB 时拒绝并保留原内容', () => {
  const { dataDir } = fakeBili(() => undefined)
  writeDiary(dataDir, 'public', '原日记')
  expect(() => writeDiary(dataDir, 'public', '中'.repeat(70000))).toThrow(/200/)
  expect(readDiaries(dataDir).public).toBe('原日记')
})

it('readLog 返回最近 N 条，最新在后', () => {
  const { dataDir } = fakeBili(() => undefined)
  for (let i = 0; i < 4; i++) appendLog(dataDir, { kind: '看视频', target: null, note: String(i) })
  expect(readLog(dataDir, 2).map((row) => row.note)).toEqual(['2', '3'])
  expect(readLog(dataDir, 0)).toEqual([])
})

it('允许恰好 200KB，拒绝多一字节，写完没有临时文件', () => {
  const { dataDir } = fakeBili(() => undefined)
  writeDiary(dataDir, 'private', 'a'.repeat(200 * 1024))
  expect(readDiaries(dataDir).private.length).toBe(200 * 1024)
  expect(() => writeDiary(dataDir, 'private', 'a'.repeat(200 * 1024 + 1))).toThrow(/200/)
  expect(fs.readdirSync(dataDir)).toEqual(['whale-diary-private.md'])
})

it('拒绝非法日记类型，不允许把类型当作路径', () => {
  const { dataDir } = fakeBili(() => undefined)
  expect(() => writeDiary(dataDir, '../outside' as 'public', '正文')).toThrow()
  expect(fs.readdirSync(dataDir)).toEqual([])
})

it('跳过坏行及形状不对的日志，再取最近有效 N 条', () => {
  const { dataDir } = fakeBili(() => undefined)
  appendLog(dataDir, { kind: '看', target: 'BV1AAAAAAAAA', note: '第一条\n第二行' })
  const file = path.join(dataDir, 'whale-log.jsonl')
  fs.appendFileSync(file, 'broken\nnull\n{"at":"bad"}\n')
  appendLog(dataDir, { kind: '想', target: null, note: '第三条' })
  const rows = readLog(dataDir, 2)
  expect(rows.map((r) => r.note)).toEqual(['第一条\n第二行', '第三条'])
  expect(Number.isFinite(Date.parse(rows[0]!.at))).toBe(true)
  expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(5)
})

it.each([-1, 1.5, NaN])('拒绝非法日志条数 %s', (limit) => {
  const { dataDir } = fakeBili(() => undefined)
  expect(() => readLog(dataDir, limit)).toThrow()
})

it('没有日志时返回空列表', () => {
  const { dataDir } = fakeBili(() => undefined)
  expect(readLog(dataDir)).toEqual([])
})

const now = new Date(2026, 9, 30, 21, 30).getTime()

it('追加不改旧字节，超过 200KB 仍可追加，返回稳定的条目 ID', () => {
  const { dataDir } = fakeBili(() => undefined)
  const file = path.join(dataDir, 'whale-diary.md')
  const old = Buffer.from('# 日记\n\n## 2026-10-29 · 早\n' + 'a'.repeat(210 * 1024))
  fs.writeFileSync(file, old)
  const { entry } = appendDiary(dataDir, 'public', '今晚看了猫', now)
  const written = fs.readFileSync(file)
  expect(written.subarray(0, old.length)).toEqual(old)
  expect(written.toString()).toContain('\n\n## 2026-10-30 · 21:30\n\n今晚看了猫')
  expect(fs.existsSync(path.join(dataDir, 'whale-diary-private.md'))).toBe(false)
  expect(readDiaryEntry(dataDir, entry)).toMatchObject({ title: '21:30', date: '2026-10-30' })
  expect(readDiaryEntry(dataDir, 'public:1')!.markdown).toContain('a'.repeat(100))
  expect(listEntries(dataDir)[0]!.id).toBe(entry)
  expect(readDiaryEntry(dataDir, 'public:999')).toBeNull()
})

it('追加只接受非空、20KB 内且不含围栏外一二级标题的正文', () => {
  const { dataDir } = fakeBili(() => undefined)
  appendDiary(dataDir, 'private', '### 小节\n```md\n# 代码示例\n## 看过\n```', now)
  const old = readDiaries(dataDir).private
  expect(() => appendDiary(dataDir, 'private', '## 看过\n正文', now)).toThrow(/###/)
  expect(() => appendDiary(dataDir, 'private', '# 本子名', now)).toThrow(/###/)
  expect(() => appendDiary(dataDir, 'private', '中'.repeat(7000), now)).toThrow(/20KB/)
  expect(() => appendDiary(dataDir, 'private', ' \n', now)).toThrow(/空/)
  expect(readDiaries(dataDir).private).toBe(old)
})

it('记忆按 Unicode 码点限 3000 字，超限保留旧文，缺文件为空', () => {
  const { dataDir } = fakeBili(() => undefined)
  expect(readMemory(dataDir)).toBe('')
  writeMemory(dataDir, '记'.repeat(10))
  expect(() => writeMemory(dataDir, '记'.repeat(3001))).toThrow(/3000/)
  expect(readMemory(dataDir)).toBe('记'.repeat(10))
  writeMemory(dataDir, '🐳'.repeat(3000))
  expect(readMemory(dataDir)).toBe('🐳'.repeat(3000))
  expect(fs.readdirSync(dataDir)).toEqual(['whale-memory.md'])
})

it('未闭合的代码围栏不能吞掉之后追加的条目', () => {
  const { dataDir } = fakeBili(() => undefined)
  expect(() => appendDiary(dataDir, 'public', '```md\n示例', now)).toThrow(/围栏.*闭合/)
  expect(readDiaries(dataDir).public).toBe('')
  const old = '## 2026-10-29 · 夜\n```md\n旧示例'
  writeDiary(dataDir, 'public', old)
  expect(() => appendDiary(dataDir, 'public', '新一篇', now)).toThrow(/旧日记.*围栏/)
  expect(readDiaries(dataDir).public).toBe(old)
})

it('记忆读取失败不能当空文件', () => {
  const { dataDir } = fakeBili(() => undefined)
  fs.mkdirSync(path.join(dataDir, 'whale-memory.md'))
  expect(() => readMemory(dataDir)).toThrow(/记忆读取失败/)
})

it('快照只含最近三个自然日，目录另含旧篇与清单', () => {
  const { dataDir } = fakeBili(() => undefined)
  writeDiary(dataDir, 'public', [
    '## 2026-10-30 · 午', '今天的猫。',
    '## 2026-10-27 · 夜', '旧文 Cat BV1AAAAAAAAA。',
    '## 看过', 'BV1BBBBBBBBB',
  ].join('\n'))
  writeDiary(dataDir, 'private', '## 2026-10-28 · 夜\n前天的心情。')
  const snapshot = readDiarySnapshot(dataDir, now)
  expect(snapshot).toMatchObject({ memory: '', today: '2026-10-30', total: 4, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  expect(snapshot.recent.map((e) => e.date)).toEqual(['2026-10-30', '2026-10-28'])
  expect(snapshot.catalog.map((e) => e.date)).toEqual(['2026-10-30', '2026-10-28', '2026-10-27', null])
  expect(searchDiaries(dataDir, 'BV1BBBBBBBBB').hits[0]).toMatchObject({ title: '看过', date: null })
  expect(searchDiaries(dataDir, '2026-10-27').hits[0]!.date).toBe('2026-10-27')
  expect(searchDiaries(dataDir, 'cat').hits[0]!.excerpt).toContain('Cat')
  expect(searchDiaries(dataDir, '猫').total).toBe(1)
  expect(searchDiaries(dataDir, '猫', 'private').hits).toEqual([])
  expect(searchDiaries(dataDir, '不存在的词')).toEqual({ total: 0, hits: [] })
})

it('目录、搜索和摘录有上限，BV 只缩短目录显示，不影响搜索', () => {
  const { dataDir } = fakeBili(() => undefined)
  const bvids = Array.from({ length: 6 }, (_, i) => `BV1AAAAAAAA${i}`)
  fs.writeFileSync(path.join(dataDir, 'whale-diary.md'), Array.from({ length: 101 }, (_, i) =>
    `## 2026-10-30 · 条目${i}\n${'🐳'.repeat(400)}猫${'字'.repeat(400)} ${bvids.join(' ')}`).join('\n'))
  const snapshot = readDiarySnapshot(dataDir, now)
  expect(snapshot.catalog).toHaveLength(100)
  expect(snapshot.total).toBe(101)
  expect(snapshot.catalog[0]).toMatchObject({ bvids: bvids.slice(0, 5), moreBvids: 1 })
  const results = searchDiaries(dataDir, '猫')
  expect(results.total).toBe(101)
  expect(results.hits).toHaveLength(10)
  expect(Array.from(results.hits[0]!.excerpt)).toHaveLength(300)
  expect(results.hits[0]!.excerpt).toContain('猫')
  expect(searchDiaries(dataDir, bvids[5]!).total).toBe(101)
})

it('跨月仍按自然日读取，午夜不按滚动 72 小时算', () => {
  const { dataDir } = fakeBili(() => undefined)
  writeDiary(dataDir, 'public', [
    '## 2026-11-01 · 00:00\n今天', '## 2026-10-30 · 00:01\n前天',
    '## 2026-10-29 · 23:59\n三天前', '## 2026-11-02 · 早\n未来',
  ].join('\n'))
  expect(readDiarySnapshot(dataDir, new Date(2026, 10, 1, 0, 5).getTime()).recent.map((e) => e.date))
    .toEqual(['2026-11-01', '2026-10-30'])
})

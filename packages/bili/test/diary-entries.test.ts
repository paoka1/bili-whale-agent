import { expect, it } from 'vitest'
import { parseDiary, sortEntries } from '../src/diary-entries.js'

it('兼容旧日记的序言、同日多篇、围栏与末尾清单，保留全部原文', () => {
  const markdown = [
    '# 小鲸 · 日记', '',
    '## 2026-10-30 · 午（醒来）', '看了一只猫。',
    '## 2026-10-29 · 早（08:44 醒）', '### 12:12 他回了', '记下反馈。',
    '## 2026-10-29 · 夜（19:41 醒）', '夜里的想法。',
    '## 2026-10-29 · 早', '```markdown', '## 2026-01-01 · 假的', '```',
    '## 2026-02-30 · 非法', '这不是有效日期。',
    '## 看过', 'BV1AAAAAAAAA、BV1BBBBBBBBB、BV1AAAAAAAAA',
    '## 谁回过我', '一位访客。', '',
  ].join('\n')
  const entries = parseDiary('public', markdown)
  expect(entries).toHaveLength(8)
  expect(entries.map((e) => e.id)).toEqual(Array.from({ length: 8 }, (_, i) => `public:${i}`))
  expect(entries.map((e) => e.markdown).join('')).toBe(markdown)
  expect(entries[2]!.markdown).toContain('### 12:12 他回了')
  expect(entries[4]!.markdown).toContain('## 2026-01-01 · 假的')
  expect(entries[5]!.date).toBeNull()
  expect(entries[6]).toMatchObject({ date: null, title: '看过', bvids: ['BV1AAAAAAAAA', 'BV1BBBBBBBBB'] })
  const sorted = sortEntries(entries)
  expect(sorted.map((e) => e.title)).toEqual([
    '午（醒来）', '夜（19:41 醒）', '早（08:44 醒）', '早',
    '# 小鲸 · 日记', '2026-02-30 · 非法', '看过', '谁回过我',
  ])
  expect(entries[2]!.title).toBe('早（08:44 醒）') // 排序不改原数组。
})

it('同日按时间、时段、文件顺序排序，跨本完全并列时公开在前', () => {
  const publicEntries = parseDiary('public', [
    '## 2026-10-30 · 第一次醒来', '第一篇。',
    '## 2026-10-30 · 又一次醒来', '第二篇。',
    '## 2026-10-30 · 早', '旧篇。',
    '## 2026-10-30 · 21:30', '追加的新篇。',
  ].join('\n'))
  const privateEntries = parseDiary('private', '## 2026-10-30 · 21:30\n私人经历。')
  expect(sortEntries([...privateEntries, ...publicEntries]).map((e) => e.id)).toEqual([
    'public:3', 'private:0', 'public:2', 'public:0', 'public:1',
  ])
  expect(sortEntries([...privateEntries, ...parseDiary('public', '## 2026-10-30 · 21:30\n公开经历。')])
    .map((e) => e.which)).toEqual(['public', 'private'])
})

it('空本无条目，CRLF 与波浪围栏内标题原样保留', () => {
  expect(parseDiary('public', '')).toEqual([])
  const markdown = '## 2024-02-29 · 下午\r\n~~~~md\r\n## 伪标题\r\n~~~~\r\n## 清单\r\n正文'
  const entries = parseDiary('private', markdown)
  expect(entries).toHaveLength(2)
  expect(entries[0]!.date).toBe('2024-02-29')
  expect(entries.map((e) => e.markdown).join('')).toBe(markdown)
})

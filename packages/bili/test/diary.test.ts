import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { appendLog, readDiaries, readLog, writeDiary } from '../src/diary.js'
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

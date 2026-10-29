import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { checkShare, recordWrite } from '../src/quota.js'
import { readJson, writeJsonAtomic } from '../src/store.js'
import { fakeBili } from './helpers.js'

const share = { bvid: 'BV1AAAAAAAAA', reason: '这段讲解清楚值得再看', score: 15, rank: 1 }
afterEach(() => { vi.unstubAllEnvs() })

it('分享第 4 条被拒，评论和私信共用额度', () => {
  const { ctx } = fakeBili(() => undefined)
  for (let i = 0; i < 3; i++) recordWrite(ctx, { type: i % 2 ? 'dm' : 'comment', target: `BV:BV${i}AAAAAAAAA`, note: '分享', auto: true, share: true })
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
})

it('同一视频 7 天内不能跨通道再分享', () => {
  const { ctx } = fakeBili(() => undefined)
  recordWrite(ctx, { type: 'dm', target: `BV:${share.bvid}`, note: '分享', auto: true, share: true })
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
})

it.each([{ reason: '太短' }, { score: 12 }, { score: 21 }, { score: NaN }, { rank: 2 }])('拒绝不符合评分卡的分享 %j', (over) => {
  const { ctx } = fakeBili(() => undefined)
  expect(checkShare(ctx, { ...share, ...over })).toMatchObject({ ok: false })
})

it('share.enabled=false 时分享被拒', () => {
  const { ctx } = fakeBili(() => undefined)
  ctx.settings.share.enabled = false
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
})

it('配置即时生效，旧账本中的额度不能覆盖配置', () => {
  const { ctx } = fakeBili(() => undefined)
  writeJsonAtomic(path.join(ctx.dataDir, 'quota.json'), { shareDaily: 999, log: [] })
  ctx.settings.quota.shareDaily = 0
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
  ctx.settings.quota.shareDaily = 1
  expect(checkShare(ctx, share)).toEqual({ ok: true })
})

it.each(['{', 'null', '{}', '{"log":{}}', '{"log":[{"at":"bad","type":"comment","target":"x"}]}'])('账本损坏时拒绝分享和记账，保留原文件 %s', (content) => {
  const { ctx } = fakeBili(() => undefined)
  const file = path.join(ctx.dataDir, 'quota.json')
  fs.writeFileSync(file, content)
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
  expect(() => recordWrite(ctx, { type: 'comment', target: share.bvid, note: '', auto: true, share: true })).toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe(content)
})

it('记账格式沿用上游，统一 BV 前缀并限制 note 长度', () => {
  const { ctx } = fakeBili(() => undefined)
  recordWrite(ctx, { type: 'comment', target: share.bvid, note: '内容 '.repeat(30), auto: true, share: true })
  const db = readJson<{ log: { at: string; target: string; note: string }[] }>(path.join(ctx.dataDir, 'quota.json'), { log: [] })
  expect(db.log).toHaveLength(1)
  expect(db.log[0]).toMatchObject({ target: `BV:${share.bvid}`, auto: true, share: true })
  expect(db.log[0]!.note.length).toBeLessThanOrEqual(40)
  expect(Date.parse(db.log[0]!.at)).toBe(ctx.now())
})

it('7 天边界到期可以再分享；主人新反馈恢复沉默衰减', () => {
  const { ctx, advance } = fakeBili(() => undefined)
  recordWrite(ctx, { type: 'comment', target: share.bvid, note: '', auto: true, share: true })
  advance(7 * 86400000)
  expect(checkShare(ctx, share)).toMatchObject({ ok: false }) // 7 天没有反馈，分享降至 0。
  writeJsonAtomic(path.join(ctx.dataDir, 'feedback.json'), { last: new Date(ctx.now()).toISOString() })
  expect(checkShare(ctx, share)).toEqual({ ok: true })
})

it.each([[0, 3], [3, 3], [4, 2], [5, 1], [6, 1], [7, 0]])('沉默第 %i 天的分享有效上限为 %i', (days, cap) => {
  const { ctx } = fakeBili(() => undefined)
  const now = ctx.now()
  const old = { at: new Date(now - days * 86400000).toISOString(), type: 'comment', target: 'BV:BV9AAAAAAAAA', share: true }
  const today = Array.from({ length: Math.max(0, cap - 1 - (days === 0 ? 1 : 0)) }, (_, i) => ({ ...old, at: new Date(now).toISOString(), target: `BV:BV${i}BBBBBBBBB` }))
  const log = [old, ...today]
  writeJsonAtomic(path.join(ctx.dataDir, 'quota.json'), { log })
  if (cap > 0) expect(checkShare(ctx, share)).toEqual({ ok: true })
  log.push({ ...old, at: new Date(now).toISOString(), target: 'BV:BV7CCCCCCCCC' })
  writeJsonAtomic(path.join(ctx.dataDir, 'quota.json'), { log })
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
})

it('午夜按本地日期计算额度，而非 ISO 串的 UTC 日期', () => {
  vi.stubEnv('TZ', 'Asia/Taipei')
  const { ctx } = fakeBili(() => undefined)
  ctx.settings.quota.shareDaily = 1
  ctx.now = () => Date.parse('2026-10-29T16:30:00Z') // 本地 10/30 00:30
  const row = { at: '2026-10-29T15:30:00Z', type: 'dm', target: 'BV:BV9AAAAAAAAA', share: true }
  writeJsonAtomic(path.join(ctx.dataDir, 'quota.json'), { log: [row] })
  expect(checkShare(ctx, share)).toEqual({ ok: true })
  row.at = '2026-10-29T16:10:00Z'
  writeJsonAtomic(path.join(ctx.dataDir, 'quota.json'), { log: [row] })
  expect(checkShare(ctx, share)).toMatchObject({ ok: false })
})

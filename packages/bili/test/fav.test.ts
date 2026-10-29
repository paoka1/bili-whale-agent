import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { addFavorite, listFavorites, type FavItem } from '../src/fav.js'
import { writeJsonAtomic } from '../src/store.js'
import { fakeBili, json } from './helpers.js'
import { BV, fakeWrites } from './write-helpers.js'

const item = (at: number, over: Partial<FavItem> = {}): FavItem => ({ bvid: 'BV9AAAAAAAAA', aid: 101, title: '视频', up: 'UP', at: new Date(at).toISOString(), reason: '教程 讲解清楚便于回看', kind: '教程', ...over })

it('收藏理由不足 6 字被拒，不发请求', async () => {
  const { ctx, calls } = fakeBili(() => undefined)
  expect(await addFavorite(ctx, { bvid: 'BV1AAAAAAAAA', reason: '好看' })).toMatchObject({ status: 'refused' })
  expect(calls).toHaveLength(0)
})

it('发送到登录小号的默认收藏夹，成功后写入本地账本', async () => {
  const s = fakeWrites()
  expect(await addFavorite(s.ctx, { bvid: BV, reason: '教程 讲解清楚便于回看' })).toEqual({ status: 'sent' })
  const form = new URLSearchParams(String(s.writes()[0]!.init.body))
  expect(form.get('add_media_ids')).toBe('11')
  expect(form.get('rid')).toBe('101')
  expect(form.get('type')).toBe('2')
  expect(s.calls.find((c) => c.url.pathname.endsWith('/list-all'))!.url.searchParams.get('up_mid')).toBe('111')
  expect(listFavorites(s.dataDir)).toMatchObject([{ bvid: BV, reason: '教程 讲解清楚便于回看', kind: '教程', favId: 11 }])
})

it('每天第 4 条收藏被拒，better 也不能绕过日上限', async () => {
  const s = fakeWrites()
  writeJsonAtomic(path.join(s.dataDir, 'favorites.json'), { items: Array.from({ length: 3 }, (_, i) => item(s.ctx.now(), { bvid: `BV${i}AAAAAAAAA` })) })
  expect(await addFavorite(s.ctx, { bvid: BV, reason: '很值得反复观看', better: true })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
})

it('30 天内重复收藏被拒，30 天到期可以再收藏', async () => {
  const s = fakeWrites()
  const at = s.ctx.now() - 29 * 86400000
  writeJsonAtomic(path.join(s.dataDir, 'favorites.json'), { items: [item(at, { bvid: BV })] })
  expect(await addFavorite(s.ctx, { bvid: BV, reason: '很值得反复观看' })).toMatchObject({ status: 'refused' })
  s.advance(86400000)
  expect(await addFavorite(s.ctx, { bvid: BV, reason: '很值得反复观看' })).toMatchObject({ status: 'sent' })
})

it('同类已有 2 条时需 better=true，仅改变 kind 不能绕过理由首词', async () => {
  const s = fakeWrites()
  writeJsonAtomic(path.join(s.dataDir, 'favorites.json'), { items: [item(s.ctx.now() - 86400000), item(s.ctx.now() - 86400000, { bvid: 'BV8AAAAAAAAA' })] })
  const input = { bvid: BV, reason: '教程 值得反复学习的讲解', kind: '换个类别' }
  expect(await addFavorite(s.ctx, input)).toMatchObject({ status: 'refused' })
  expect(await addFavorite(s.ctx, { ...input, better: true })).toMatchObject({ status: 'sent' })
})

it('演练模式返回预览，不请求 B 站或写入收藏额度', async () => {
  const s = fakeWrites()
  s.ctx.dryRun = true
  expect(await addFavorite(s.ctx, { bvid: BV, reason: '值得反复学习的讲解' })).toMatchObject({ status: 'dry-run', preview: expect.stringContaining(BV) })
  expect(s.calls).toHaveLength(0)
  expect(listFavorites(s.dataDir)).toEqual([])
})

it('收藏失败不记账，不泄露接口原文', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname.endsWith('/resource/deal') ? json({ code: -111, message: 'SESS-SECRET JCT' }) : undefined })
  const result = await addFavorite(s.ctx, { bvid: BV, reason: '很值得反复观看' })
  expect(result).toMatchObject({ status: 'refused' })
  expect(JSON.stringify(result)).not.toMatch(/SESS-SECRET|JCT/)
  expect(listFavorites(s.dataDir)).toEqual([])
})

it('新用户读取空收藏无需凭据，同时兼容上游 bv 字段', () => {
  const s = fakeWrites()
  expect(listFavorites(s.dataDir)).toEqual([])
  const { bvid, ...legacy } = item(s.ctx.now())
  writeJsonAtomic(path.join(s.dataDir, 'favorites.json'), { items: [{ ...legacy, bv: bvid }] })
  expect(listFavorites(s.dataDir)[0]!.bvid).toBe(bvid)
  expect(s.calls).toHaveLength(0)
})

it.each(['{', 'null', '{}', '{"items":[{}]}'])('损坏的收藏账本拒绝写入 %s', async (content) => {
  const s = fakeWrites()
  const file = path.join(s.dataDir, 'favorites.json')
  fs.writeFileSync(file, content)
  expect(await addFavorite(s.ctx, { bvid: BV, reason: '很值得反复观看' })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
  expect(fs.readFileSync(file, 'utf8')).toBe(content)
})

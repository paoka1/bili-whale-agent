import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { addDraft, approveDraft, listDrafts, rejectDraft } from '../src/drafts.js'
import { LoginExpiredError } from '../src/api.js'
import { readJson } from '../src/store.js'
import { fakeBili, json } from './helpers.js'
import { draftInput, fakeWrites } from './write-helpers.js'

it('approveDraft 发送失败时草稿保留在队列', async () => {
  const { ctx } = fakeBili(() => undefined, { dryRun: false })
  const d = addDraft(ctx, { bvid: 'BV1AAAAAAAAA', oid: '101', root: '9', parent: '9', who: '访客', src: '他说的话', message: '谢谢你的建议' })
  expect(await approveDraft(ctx, d.id)).toMatchObject({ status: 'refused' })
  expect(listDrafts(ctx.dataDir)).toEqual([d])
})

it('审批成功可以回复陌生人，发送完成后才从队列删除', async () => {
  const s = fakeWrites({ parentMid: '333' })
  const d = addDraft(s.ctx, draftInput)
  expect(await approveDraft(s.ctx, d.id)).toMatchObject({ status: 'sent', rpid: '1000' })
  expect(listDrafts(s.dataDir)).toEqual([])
  const form = new URLSearchParams(String(s.writes()[0]!.init.body))
  expect(form.get('message')).toBe(d.message)
  expect(form.get('parent')).toBe(d.parent)
})

it('同一 parent 不重复入队，也不替换待审正文', () => {
  const s = fakeWrites()
  const first = addDraft(s.ctx, draftInput)
  expect(addDraft(s.ctx, { ...draftInput, message: '改成了另一句话' })).toEqual(first)
  expect(listDrafts(s.dataDir)).toEqual([first])
})

it('演练审批保留草稿、不发送且不记额度', async () => {
  const s = fakeWrites()
  s.ctx.dryRun = true
  const d = addDraft(s.ctx, draftInput)
  expect(await approveDraft(s.ctx, d.id)).toEqual({ status: 'dry-run', preview: d.message })
  expect(listDrafts(s.dataDir)).toEqual([d])
  expect(s.writes()).toHaveLength(0)
  expect(fs.existsSync(path.join(s.dataDir, 'quota.json'))).toBe(false)
})

it('实际 POST 失败保留草稿，下次可重新审批', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/add' ? json({ code: 12002 }) : undefined })
  const d = addDraft(s.ctx, draftInput)
  expect(await approveDraft(s.ctx, d.id)).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(1)
  expect(listDrafts(s.dataDir)).toEqual([d])
})

it('发送时登录失效上抛且保留草稿', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/add' ? json({ code: -101 }) : undefined })
  const d = addDraft(s.ctx, draftInput)
  await expect(approveDraft(s.ctx, d.id)).rejects.toBeInstanceOf(LoginExpiredError)
  expect(listDrafts(s.dataDir)).toEqual([d])
})

it('成功发送后复核触发登录失效，仍不能把已发草稿恢复到队列', async () => {
  let reads = 0
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname === '/x/v2/reply/reply' && ++reads > 1) return json({ code: -101 })
  } })
  const d = addDraft(s.ctx, draftInput)
  await expect(approveDraft(s.ctx, d.id)).rejects.toBeInstanceOf(LoginExpiredError)
  expect(s.writes()).toHaveLength(1)
  expect(listDrafts(s.dataDir)).toEqual([])
})

it('并发审批同一条草稿只发送一次', async () => {
  const s = fakeWrites()
  const d = addDraft(s.ctx, draftInput)
  const results = await Promise.all([approveDraft(s.ctx, d.id), approveDraft(s.ctx, d.id)])
  expect(results.map((r) => r.status)).toEqual(['sent', 'refused'])
  expect(s.writes()).toHaveLength(1)
})

it('等待发送时新增的其他草稿不会被覆盖', async () => {
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname === '/x/v2/reply/add') addDraft(s.ctx, { ...draftInput, root: '10', parent: '10' })
  } })
  const d = addDraft(s.ctx, draftInput)
  expect(await approveDraft(s.ctx, d.id)).toMatchObject({ status: 'sent' })
  expect(listDrafts(s.dataDir)).toMatchObject([{ parent: '10' }])
})

it('拒绝草稿时保存理由，不发任何请求', () => {
  const s = fakeWrites()
  const d = addDraft(s.ctx, draftInput)
  rejectDraft(s.dataDir, d.id, '语气太冲')
  expect(listDrafts(s.dataDir)).toEqual([])
  expect(readJson(path.join(s.dataDir, 'pending-replies.json'), {})).toMatchObject({ rejected: [{ id: d.id, reason: '语气太冲' }] })
  expect(s.calls).toHaveLength(0)
})

it('正在发送的草稿不能同时撤回', async () => {
  let rejected = false
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname === '/x/v2/reply/add') {
      expect(() => rejectDraft(s.dataDir, d.id)).toThrow(/正在发送/)
      rejected = true
    }
  } })
  const d = addDraft(s.ctx, draftInput)
  expect(await approveDraft(s.ctx, d.id)).toMatchObject({ status: 'sent' })
  expect(rejected).toBe(true)
})

it('草稿 oid 与视频不一致时不发送', async () => {
  const s = fakeWrites()
  const d = addDraft(s.ctx, { ...draftInput, oid: '999' })
  expect(await approveDraft(s.ctx, d.id)).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(0)
  expect(listDrafts(s.dataDir)).toEqual([d])
})

it.each([{ bvid: '../x' }, { root: 'bad' }, { parent: '0' }, { message: ' ' }, { message: 'x'.repeat(501) }])('无效草稿被拒 %j', (over) => {
  const s = fakeWrites()
  expect(() => addDraft(s.ctx, { ...draftInput, ...over })).toThrow()
})

it('草稿队列损坏时不能当作空队列覆盖', () => {
  const s = fakeWrites()
  const file = path.join(s.dataDir, 'pending-replies.json')
  fs.writeFileSync(file, '{')
  expect(() => listDrafts(s.dataDir)).toThrow()
  expect(() => addDraft(s.ctx, draftInput)).toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe('{')
})

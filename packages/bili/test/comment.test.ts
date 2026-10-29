import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { postComment } from '../src/comment.js'
import { LoginExpiredError } from '../src/api.js'
import { readJson } from '../src/store.js'
import { TrafficError } from '../src/traffic.js'
import { fakeBili, json } from './helpers.js'
import { BV, fakeWrites, share } from './write-helpers.js'

it('dryRun 时 postComment 不发写请求并返回预览', async () => {
  const { ctx, calls } = fakeBili(() => undefined)
  expect(await postComment(ctx, { bvid: 'BV1AAAAAAAAA', message: '看完觉得很有意思' })).toMatchObject({ status: 'dry-run', preview: '看完觉得很有意思' })
  expect(calls.some((c) => c.init.method === 'POST')).toBe(false)
})

it('分享自动补 @主人，成功后记账并回读核实署名和正文', async () => {
  const s = fakeWrites()
  expect(await postComment(s.ctx, { bvid: BV, message: '这段值得看看', share })).toEqual({ status: 'sent', rpid: '1000' })
  expect(s.writes()).toHaveLength(1)
  const sent = s.writes()[0]!
  const form = new URLSearchParams(String(sent.init.body))
  expect(form.get('message')).toBe('@主人 这段值得看看')
  expect(form.get('oid')).toBe('101')
  expect(form.get('csrf')).toBe('JCT')
  expect(sent.url.searchParams.has('csrf')).toBe(false)
  expect(sent.url.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/)
  expect(s.calls.at(-1)!.url.searchParams.get('root')).toBe('1000')
  expect(readJson(path.join(s.dataDir, 'quota.json'), {})).toMatchObject({ log: [{ type: 'comment', target: `BV:${BV}`, share: true }] })
})

it('演练时记录预览但不消耗分享额度', async () => {
  const s = fakeWrites()
  s.ctx.dryRun = true
  expect(await postComment(s.ctx, { bvid: BV, message: '值得看看', share })).toEqual({ status: 'dry-run', preview: '@主人 值得看看' })
  expect(s.calls).toHaveLength(0)
  expect(fs.existsSync(path.join(s.dataDir, 'quota.json'))).toBe(false)
  expect(fs.readFileSync(path.join(s.dataDir, 'whale-log.jsonl'), 'utf8')).toContain('@主人 值得看看')
})

it.each(['333', '2220'])('回复非主人 mid %s 被拒，昵称相同也不能绕过', async (parentMid) => {
  const s = fakeWrites({ parentMid })
  expect(await postComment(s.ctx, { bvid: BV, root: '0', parent: '9', message: '谢谢你的建议' })).toEqual({ status: 'refused', reason: '回复非主人只能写草稿' })
  expect(s.writes()).toHaveLength(0)
})

it('回复主人：root=0 归一为 parent，并可从 data.root 核实顶层作者', async () => {
  const s = fakeWrites({ parentMid: '222' })
  expect(await postComment(s.ctx, { bvid: BV, root: '0', parent: '9', message: '收到你的建议了' })).toMatchObject({ status: 'sent' })
  const form = new URLSearchParams(String(s.writes()[0]!.init.body))
  expect(form.get('root')).toBe('9')
  expect(form.get('parent')).toBe('9')
})

// 2026-10-29 真机：楼中楼回复，B 站回读的正文前会自动加「回复 @昵称 :」，不能当成复核失败
it.each([['收到', undefined], ['别的话', expect.stringContaining('复核未通过')]])('楼中楼回读带「回复 @」前缀：%s', async (stored, reason) => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/reply' ? json({ code: 0, data: {
    root: { rpid_str: '9', mid: '222', content: { message: '主楼' } },
    replies: [{ rpid_str: '99', mid: '222', content: { message: '主人的回复' } }, { rpid_str: '1000', mid: '111', content: { message: `回复 @主人 :${stored}` } }],
  } }) : undefined })
  const r = await postComment(s.ctx, { bvid: BV, root: '9', parent: '99', message: '收到' })
  expect(r).toEqual({ status: 'sent', rpid: '1000', ...(reason ? { reason } : {}) })
})

it('查不到被回复者时拒绝直发，演练也要过这个闸门', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/reply' ? json({ code: 0, data: { replies: [] } }) : undefined })
  s.ctx.dryRun = true
  expect(await postComment(s.ctx, { bvid: BV, parent: '9', message: '想回一句' })).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(0)
})

it('主人在楼中楼第二页时继续翻页核实', async () => {
  let checked = false
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname !== '/x/v2/reply/reply' || checked) return
    if (url.searchParams.get('pn') === '1') return json({ code: 0, data: { replies: [{ rpid_str: '8', mid: '333' }] } })
    checked = true
    return json({ code: 0, data: { replies: [{ rpid_str: '99', mid: '222' }] } })
  } })
  expect(await postComment(s.ctx, { bvid: BV, root: '9', parent: '99', message: '收到' })).toMatchObject({ status: 'sent' })
})

it.each([
  { bvid: '../x', message: '正文' }, { bvid: BV, message: '' }, { bvid: BV, message: 'x'.repeat(1001) },
  { bvid: BV, message: '正文', root: '9' }, { bvid: BV, message: '正文', parent: '1&oid=2' },
  { bvid: BV, message: '@别人 看看', share }, { bvid: BV, message: '@主人冒牌 看看', share },
])('拒绝无效评论输入 %j', async (input) => {
  const s = fakeWrites()
  expect(await postComment(s.ctx, input)).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(0)
})

it('凭据对应的账号与 self.mid 不同时拒绝写入', async () => {
  const s = fakeWrites()
  s.ctx.settings.self.mid = '999'
  expect(await postComment(s.ctx, { bvid: BV, message: '正文' })).toMatchObject({ status: 'refused', reason: expect.stringContaining('小号不一致') })
  expect(s.writes()).toHaveLength(0)
})

it('发送失败不记账，错误不回显接口正文或凭据', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/add' ? json({ code: 12002, message: 'SESS-SECRET JCT' }) : undefined })
  const result = await postComment(s.ctx, { bvid: BV, message: '正文' })
  expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('评论区已关闭') })
  expect(JSON.stringify(result)).not.toMatch(/SESS-SECRET|JCT/)
  expect(fs.existsSync(path.join(s.dataDir, 'quota.json'))).toBe(false)
})

it('登录失效一路上抛', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/add' ? json({ code: -101 }) : undefined })
  await expect(postComment(s.ctx, { bvid: BV, message: '正文' })).rejects.toBeInstanceOf(LoginExpiredError)
})

it('写入计数超过 writeHourly 时抛 TrafficError，不发第二个 POST', async () => {
  const s = fakeWrites()
  s.ctx.settings.risk.writeHourly = 1
  expect(await postComment(s.ctx, { bvid: BV, message: '第一条' })).toMatchObject({ status: 'sent' })
  s.advance(121000)
  await expect(postComment(s.ctx, { bvid: BV, message: '第二条' })).rejects.toBeInstanceOf(TrafficError)
  expect(s.writes()).toHaveLength(1)
})

it('署名不符时保留已发送事实和额度，要求人工核查', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/v2/reply/reply'
    ? json({ code: 0, data: { root: { rpid_str: '1000', mid: '999', content: { message: '正文' } } } }) : undefined })
  expect(await postComment(s.ctx, { bvid: BV, message: '正文' })).toMatchObject({ status: 'sent', reason: expect.stringContaining('署名') })
  expect(readJson(path.join(s.dataDir, 'quota.json'), {})).toMatchObject({ log: [{ type: 'comment' }] })
})

it('楼中楼查不到新顶层评论时从主列表回读', async () => {
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname === '/x/v2/reply/reply') return json({ code: 0, data: { replies: [] } })
    if (url.pathname === '/x/v2/reply') return json({ code: 0, data: { replies: [{ rpid_str: '1000', mid: '111', content: { message: '正文' } }] } })
  } })
  expect(await postComment(s.ctx, { bvid: BV, message: '正文' })).toEqual({ status: 'sent', rpid: '1000' })
})

it('评论大整数 ID 不经过 Number 转换，回读使用精确原值', async () => {
  const id = '1262823889456594949'
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname === '/x/v2/reply/add') return new Response(`{"code":0,"data":{"rpid":${id}}}`, { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/x/v2/reply/reply') return new Response(`{"code":0,"data":{"root":{"rpid":${id},"mid":111,"content":{"message":"正文"}}}}`, { headers: { 'content-type': 'application/json' } })
  } })
  expect(await postComment(s.ctx, { bvid: BV, message: '正文' })).toEqual({ status: 'sent', rpid: id })
  expect(s.calls.at(-1)!.url.searchParams.get('root')).toBe(id)
})

it('并发分享相同视频只能发送一次，即使正文不同', async () => {
  const s = fakeWrites()
  const results = await Promise.all(['第一条', '换个说法'].map((message) => postComment(s.ctx, { bvid: BV, message, share })))
  expect(results.map((r) => r.status)).toEqual(['sent', 'refused'])
  expect(s.writes()).toHaveLength(1)
})

it('其他进程持有写锁时拒绝发送，锁释放后可以继续', async () => {
  const s = fakeWrites()
  const file = path.join(s.dataDir, 'write-actions.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }))
  expect(await postComment(s.ctx, { bvid: BV, message: '正文' })).toMatchObject({ status: 'refused', reason: expect.stringContaining('正在处理') })
  expect(s.calls).toHaveLength(0)
  expect(fs.existsSync(file)).toBe(true)
  fs.unlinkSync(file)
  expect(await postComment(s.ctx, { bvid: BV, message: '正文' })).toMatchObject({ status: 'sent' })
  expect(fs.existsSync(file)).toBe(false)
})

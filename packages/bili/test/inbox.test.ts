import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { pullInbox } from '../src/inbox.js'
import { LoginExpiredError } from '../src/api.js'
import { readJson, writeJsonAtomic } from '../src/store.js'
import { TrafficError } from '../src/traffic.js'
import { fakeBili, json } from './helpers.js'

const at = 1761740000
const notification = (id = '1', over: Record<string, unknown> = {}) => ({
  id, reply_time: at, user: { mid: 222, nickname: '主人' },
  item: { subject_id: 101, business_id: 1, root_id: 0, source_id: '9', uri: 'https://www.bilibili.com/video/BV1AAAAAAAAA', title: '错误标题', source_content: '错误正文' }, ...over,
})
const reply = (over: Record<string, unknown> = {}) => ({ rpid_str: '9', mid: 222, ctime: at, member: { mid: 222, uname: '改名后的主人' }, content: { message: '真实正文' }, ...over })

it('按精确 mid 标识主人，正文回读楼层并保留大整数坐标', async () => {
  const { ctx, calls } = fakeBili((url) => {
    if (url.pathname === '/x/msgfeed/reply') return new Response('{"code":0,"data":{"items":[{"id":9007199254740993,"reply_time":1000,"user":{"mid":222,"nickname":"主人"},"item":{"subject_id":1262823889456594949,"business_id":17,"root_id":0,"source_id":9007199254740995,"title":"错误标题","source_content":"错误正文"}}]}}', { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/x/msgfeed/at') return json({ code: 0, data: { items: [] } })
    if (url.pathname === '/x/v2/reply/reply') return new Response('{"code":0,"data":{"root":{"rpid":9007199254740995,"mid":222,"ctime":1000,"content":{"message":"核实的正文"}},"replies":[]}}', { headers: { 'content-type': 'application/json' } })
  })
  ctx.settings.owner.mid = '222'
  const rows = await pullInbox(ctx, { sinceMs: 0 })
  expect(rows).toMatchObject([{ id: '9007199254740993', from: 'owner', oid: '1262823889456594949', root: '9007199254740995', parent: '9007199254740995', type: 17, text: '核实的正文', at: 1000000 }])
  const thread = calls.find((c) => c.url.pathname === '/x/v2/reply/reply')!
  expect(thread.url.searchParams.get('type')).toBe('17')
  expect(thread.url.searchParams.get('oid')).toBe('1262823889456594949')
})

it('回复及 @ 都回读正文，按 mid 识别主人并回写反馈', async () => {
  const s = fakeBili((url) => {
    if (url.pathname === '/x/msgfeed/reply') return json({ code: 0, data: { items: [notification()] } })
    if (url.pathname === '/x/msgfeed/at') return json({ code: 0, data: { items: [notification('2', { user: { mid: 333, nickname: '主人' }, item: { subject_id: 101, source_id: '10', root_id: '10', business_id: 1 } })] } })
    if (url.pathname === '/x/v2/reply/reply') return json({ code: 0, data: { root: url.searchParams.get('root') === '9' ? reply() : reply({ rpid_str: '10', mid: 333, member: { mid: 333, uname: '主人' } }), replies: [] } })
  })
  s.ctx.settings.owner = { mid: '222', name: '主人' }
  const items = await pullInbox(s.ctx, { sinceMs: 0 })
  expect(items.map((i) => [i.kind, i.from, i.text])).toEqual([['reply', 'owner', '真实正文'], ['at', 'other', '真实正文']])
  expect(items[0]!.bvid).toBe('BV1AAAAAAAAA')
  expect(readJson(path.join(s.dataDir, 'feedback.json'), {})).toEqual({ last: new Date(at * 1000).toISOString() })
  expect(s.calls.every((c) => !c.init.method || c.init.method === 'GET')).toBe(true)
})

it('只按精确 ID 和作者匹配，查不到时不退回通知正文或同作者其他评论', async () => {
  const s = fakeBili((url) => {
    if (url.pathname.includes('/msgfeed/')) return json({ code: 0, data: { items: url.pathname.endsWith('/reply') ? [notification()] : [] } })
    return json({ code: 0, data: { root: reply({ rpid_str: '8', parent: '7' }), replies: [reply({ mid: 333, member: { mid: 333 } })] } })
  })
  s.ctx.settings.owner.mid = '222'
  expect(await pullInbox(s.ctx, { sinceMs: 0 })).toEqual([])
  expect(fs.existsSync(path.join(s.dataDir, 'feedback.json'))).toBe(false)
})

it('分页重叠按 kind/id 去重，同一线程只回读一次', async () => {
  const s = fakeBili((url) => {
    if (url.pathname === '/x/msgfeed/reply') return json({ code: 0, data: { items: [notification()], cursor: url.searchParams.has('cursor') ? '' : 'next&cursor' } })
    if (url.pathname === '/x/msgfeed/at') return json({ code: 0, data: { items: [] } })
    return json({ code: 0, data: { root: reply(), replies: [] } })
  })
  expect(await pullInbox(s.ctx, { sinceMs: 0, pages: 2 })).toHaveLength(1)
  expect(s.calls.filter((c) => c.url.pathname === '/x/v2/reply/reply')).toHaveLength(1)
  expect(s.calls.find((c) => c.url.searchParams.has('cursor'))!.url.searchParams.get('cursor')).toBe('next&cursor')
})

it('兼容对象游标，传完整 id 和通知时间，不将对象转为字符串', async () => {
  const s = fakeBili((url) => {
    if (url.pathname === '/x/msgfeed/reply') return json({ code: 0, data: { items: [notification()], cursor: url.searchParams.has('id') ? { is_end: true } : { id: '9007199254740993', time: at, is_end: false } } })
    if (url.pathname === '/x/msgfeed/at') return json({ code: 0, data: { items: [] } })
    return json({ code: 0, data: { root: reply(), replies: [] } })
  })
  expect(await pullInbox(s.ctx, { sinceMs: 0, pages: 2 })).toHaveLength(1)
  const second = s.calls.find((c) => c.url.searchParams.has('id'))!.url
  expect(second.searchParams.get('id')).toBe('9007199254740993')
  expect(second.searchParams.get('reply_time')).toBe(String(at))
})

it('最多核实 20 条，优先处理较早通知', async () => {
  const s = fakeBili((url) => {
    if (url.pathname.includes('/msgfeed/')) return json({ code: 0, data: { items: url.pathname.endsWith('/reply') ? Array.from({ length: 25 }, (_, i) => notification(String(i + 1))) : [] } })
    return json({ code: 0, data: { root: reply(), replies: [] } })
  })
  expect(await pullInbox(s.ctx, { sinceMs: 0 })).toHaveLength(20)
  expect(s.calls.filter((c) => c.url.pathname === '/x/v2/reply/reply')).toHaveLength(1)
})

it('过滤时间窗外的通知，不发楼层核实请求', async () => {
  const s = fakeBili(() => json({ code: 0, data: { items: [notification()] } }))
  expect(await pullInbox(s.ctx, { sinceMs: (at + 1) * 1000 })).toEqual([])
  expect(s.calls).toHaveLength(2)
})

it('主人反馈时间只前进，保留其他反馈字段', async () => {
  const s = fakeBili((url) => url.pathname.includes('/msgfeed/')
    ? json({ code: 0, data: { items: url.pathname.endsWith('/reply') ? [notification()] : [] } })
    : json({ code: 0, data: { root: reply(), replies: [] } }))
  s.ctx.settings.owner.mid = '222'
  const last = new Date((at + 100) * 1000).toISOString()
  writeJsonAtomic(path.join(s.dataDir, 'feedback.json'), { last, events: ['已有反馈'] })
  await pullInbox(s.ctx, { sinceMs: 0 })
  expect(readJson(path.join(s.dataDir, 'feedback.json'), {})).toEqual({ last, events: ['已有反馈'] })
})

it('楼层在第二页时继续核实，返回确切 rpid', async () => {
  const s = fakeBili((url) => {
    if (url.pathname.includes('/msgfeed/')) return json({ code: 0, data: { items: url.pathname.endsWith('/reply') ? [notification()] : [] } })
    return json({ code: 0, data: { replies: url.searchParams.get('pn') === '1' ? Array.from({ length: 20 }, () => reply({ rpid_str: '8' })) : [reply()] } })
  })
  expect(await pullInbox(s.ctx, { sinceMs: 0 })).toMatchObject([{ parent: '9', text: '真实正文' }])
})

it.each([-101, -412])('楼层读取 code=%s 时上抛登录失效或风控暂停', async (code) => {
  const s = fakeBili((url) => url.pathname.includes('/msgfeed/')
    ? json({ code: 0, data: { items: url.pathname.endsWith('/reply') ? [notification(), notification('2', { item: { subject_id: 102, source_id: '10' } })] : [] } })
    : json({ code }))
  if (code === -101) await expect(pullInbox(s.ctx, { sinceMs: 0 })).rejects.toBeInstanceOf(LoginExpiredError)
  else await expect(pullInbox(s.ctx, { sinceMs: 0 })).rejects.toBeInstanceOf(TrafficError)
})

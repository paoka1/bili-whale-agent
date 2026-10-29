import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { pullOwnerDms } from '../src/owner-dm.js'
import { LoginExpiredError } from '../src/api.js'
import { readJson, writeJsonAtomic } from '../src/store.js'
import { fakeBili, json } from './helpers.js'

const row = (seq: number | string, over: Record<string, unknown> = {}) => ({ msg_seqno: String(seq), msg_key: String(seq), timestamp: 1000, sender_uid: 222, content: JSON.stringify({ content: `消息 ${seq}` }), ...over })
const page = (messages: unknown[], has_more: number | string | boolean = 0) => json({ code: 0, data: { messages, has_more } })
const unread = { baseline: true, lastSeq: '1' }

function setup(handler: (url: URL) => Response | undefined) {
  const s = fakeBili((url) => url.pathname.endsWith('/fetch_session_msgs') ? handler(url) : undefined)
  s.ctx.settings.owner.mid = '222'
  return s
}

it('首次建立基线，不重放历史私信', async () => {
  const { ctx } = fakeBili((url) => url.pathname.endsWith('/fetch_session_msgs') ? json({ code: 0, data: { messages: [
    { msg_seqno: '2', msg_key: '2', timestamp: 1000, sender_uid: 222, content: '{"content":"历史消息"}' },
  ], has_more: 1 } }) : undefined)
  ctx.settings.owner.mid = '222'
  expect(await pullOwnerDms(ctx, { baseline: false, lastSeq: null })).toEqual({ messages: [], state: { baseline: true, lastSeq: '2' } })
})

it('首次基线不计为新反馈，重启使用持久化游标', async () => {
  const s = setup(() => page([row(2), row(1)]))
  const initial = { baseline: false, lastSeq: null }
  expect((await pullOwnerDms(s.ctx, initial)).messages).toEqual([])
  expect(fs.existsSync(path.join(s.dataDir, 'feedback.json'))).toBe(false)
  expect(await pullOwnerDms(s.ctx, initial)).toEqual({ messages: [], state: { baseline: true, lastSeq: '2' } })
  expect(initial).toEqual({ baseline: false, lastSeq: null })
})

it('自己最新发的消息不遮住主人连续消息，跨页重叠去重并按序号排序', async () => {
  const s = setup((url) => url.searchParams.get('begin_seqno') === '0'
    ? page([row(4, { sender_uid: 111 }), row(3)], 1) : page([row(3), row(2), row(1)]))
  const result = await pullOwnerDms(s.ctx, unread)
  expect(result.messages.map((r) => r.id)).toEqual(['2', '3'])
  expect(result.state).toEqual({ baseline: true, lastSeq: '4' })
  const calls = s.calls.filter((c) => c.url.pathname.endsWith('/fetch_session_msgs'))
  expect(calls.map((c) => c.url.searchParams.get('begin_seqno'))).toEqual(['0', '3'])
  expect(calls.every((c) => c.url.searchParams.get('talker_id') === '222')).toBe(true)
  expect(calls[0]!.url.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/)
  expect(readJson(path.join(s.dataDir, 'feedback.json'), {})).toEqual({ last: '1970-01-01T00:16:40.000Z' })
  expect((await pullOwnerDms(s.ctx, result.state)).messages).toEqual([])
})

it('同秒不同序号不会漏报，大整数序号和 ID 保持精确', async () => {
  const s = setup(() => new Response('{"code":0,"data":{"messages":[{"msg_seqno":9007199254740993,"msg_key":9007199254740995,"timestamp":1000,"sender_uid":222,"content":"{\\"content\\":\\"精确消息\\"}"}],"has_more":0}}', { headers: { 'content-type': 'application/json' } }))
  expect(await pullOwnerDms(s.ctx, { baseline: true, lastSeq: '9007199254740992' })).toEqual({
    messages: [{ id: '9007199254740995', text: '精确消息', at: 1000000 }], state: { baseline: true, lastSeq: '9007199254740993' },
  })
})

it('撤回、图片和自己发出的消息不当作新聊天，已撤回文本也不返回', async () => {
  const s = setup(() => page([
    row(5, { msg_type: 5, content: '"1"' }), row(4, { msg_type: 2, content: '{"url":"图片"}' }),
    row(3), row(2, { sender_uid: 111 }), row(1),
  ]))
  expect(await pullOwnerDms(s.ctx, { baseline: true, lastSeq: '0' })).toEqual({ messages: [{ id: '3', text: '消息 3', at: 1000000 }], state: { baseline: true, lastSeq: '5' } })
})

it('空基线后出现第一条消息时正常返回', async () => {
  let empty = true
  const s = setup(() => page(empty ? [] : [row(1)]))
  expect(await pullOwnerDms(s.ctx, { baseline: false, lastSeq: null })).toEqual({ messages: [], state: { baseline: true, lastSeq: null } })
  empty = false
  expect((await pullOwnerDms(s.ctx, { baseline: true, lastSeq: null })).messages).toMatchObject([{ id: '1' }])
})

it('部分分页失败不推进已读状态，不更新反馈', async () => {
  const s = setup((url) => url.searchParams.get('begin_seqno') === '0' ? page([row(3), row(2)], 1) : json({ code: -500, message: 'SESS-SECRET JCT' }))
  const file = path.join(s.dataDir, 'owner-dm-state.json')
  writeJsonAtomic(file, unread)
  const before = fs.readFileSync(file, 'utf8')
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toThrow(/保留游标/)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  expect(fs.existsSync(path.join(s.dataDir, 'feedback.json'))).toBe(false)
})

it('分页循环不前进时保留游标', async () => {
  const s = setup(() => page([row(3), row(2)], 1))
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toThrow(/前进/)
  expect(fs.existsSync(path.join(s.dataDir, 'owner-dm-state.json'))).toBe(false)
})

it('积压超过 10 页时失败，不跳过未读消息', async () => {
  let next = 100
  const s = setup(() => page([row(next--)], 1))
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toThrow(/10 页/)
  expect(s.calls.filter((c) => c.url.pathname.endsWith('/fetch_session_msgs'))).toHaveLength(10)
  expect(fs.existsSync(path.join(s.dataDir, 'owner-dm-state.json'))).toBe(false)
})

it.each(['broken', 'null', '{}', '{"baseline":true,"lastSeq":"bad"}'])('损坏的持久化状态不能被覆盖 %s', async (content) => {
  const s = setup(() => page([row(2)]))
  const file = path.join(s.dataDir, 'owner-dm-state.json')
  fs.writeFileSync(file, content)
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe(content)
  expect(s.calls).toHaveLength(0)
})

it('更换主人或登录小号后重新建立基线', async () => {
  const s = setup(() => page([row(2)]))
  writeJsonAtomic(path.join(s.dataDir, 'owner-dm-state.json'), { ...unread, owner: '999', self: '' })
  expect((await pullOwnerDms(s.ctx, unread)).messages).toEqual([])
  expect(fs.existsSync(path.join(s.dataDir, 'feedback.json'))).toBe(false)
})

it('并发轮询串行合并游标，一批消息只交付一次', async () => {
  const s = setup(() => page([row(2), row(1)]))
  const results = await Promise.all([pullOwnerDms(s.ctx, unread), pullOwnerDms(s.ctx, unread)])
  expect(results.flatMap((r) => r.messages).map((m) => m.id)).toEqual(['2'])
})

it('旧消息只按消息本身时间回写反馈，不能用轮询时间清零沉默', async () => {
  const s = setup(() => page([row(2)]))
  const file = path.join(s.dataDir, 'feedback.json')
  writeJsonAtomic(file, { last: '2026-10-28T00:00:00.000Z', events: ['已有反馈'] })
  await pullOwnerDms(s.ctx, unread)
  expect(readJson(file, {})).toEqual({ last: '2026-10-28T00:00:00.000Z', events: ['已有反馈'] })
})

it('主人新反馈让 Task5 已停止的分享重新可用', async () => {
  const { checkShare, recordWrite } = await import('../src/quota.js')
  const s = setup(() => page([row(2, { timestamp: Math.floor(s.ctx.now() / 1000) })]))
  recordWrite(s.ctx, { type: 'comment', target: 'BV:BV9AAAAAAAAA', note: '旧分享', auto: true, share: true })
  s.advance(8 * 86400000)
  const share = { bvid: 'BV1AAAAAAAAA', reason: '这个讲解清晰值得分享', score: 15, rank: 1 }
  expect(checkShare(s.ctx, share)).toMatchObject({ ok: false })
  await pullOwnerDms(s.ctx, unread)
  expect(checkShare(s.ctx, share)).toEqual({ ok: true })
})

it('服务器时钟比 B 站慢几秒时，主人刚发的私信不能因「未来时间」被跳过', async () => {
  const s = setup(() => page([row(2, { timestamp: Math.floor(s.ctx.now() / 1000) + 5 })]))
  expect((await pullOwnerDms(s.ctx, unread)).messages.map((m) => m.id)).toEqual(['2'])
  // 游标已越过这条，若被跳过就再也读不到；反馈时间按本机当前时间记，不写入未来时间
  const last = readJson<{ last?: string }>(path.join(s.dataDir, 'feedback.json'), {}).last
  expect(Date.parse(last!)).toBe(s.ctx.now())
})

it('登录失效上抛，不落盘游标', async () => {
  const s = setup(() => json({ code: -101 }))
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toBeInstanceOf(LoginExpiredError)
  expect(fs.existsSync(path.join(s.dataDir, 'owner-dm-state.json'))).toBe(false)
})

it('缺少消息序号时保留游标，不用时间戳猜测已读边界', async () => {
  const s = setup(() => page([row(2, { msg_seqno: undefined })]))
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toThrow(/序号/)
  expect(fs.existsSync(path.join(s.dataDir, 'owner-dm-state.json'))).toBe(false)
})

it('反馈记录损坏时不覆盖旧数据，也不推进私信游标', async () => {
  const s = setup(() => page([row(2)]))
  const file = path.join(s.dataDir, 'feedback.json')
  fs.writeFileSync(file, 'broken')
  await expect(pullOwnerDms(s.ctx, unread)).rejects.toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe('broken')
  expect(fs.existsSync(path.join(s.dataDir, 'owner-dm-state.json'))).toBe(false)
})

it('撤回正文里的大整数消息 key 也保持精确，不返回被撤回消息', async () => {
  const s = setup(() => page([
    row(3), row(2, { msg_type: 5, content: '{"msg_key":9007199254740993}' }), row(1, { msg_key: '9007199254740993' }),
  ]))
  expect((await pullOwnerDms(s.ctx, { baseline: true, lastSeq: '0' })).messages.map((r) => r.id)).toEqual(['3'])
})

it('按消息时间排序，时间相同再按精确序号排序，游标仍取最大序号', async () => {
  const s = setup(() => page([row(1), row(2, { timestamp: 999 })]))
  const result = await pullOwnerDms(s.ctx, { baseline: true, lastSeq: '0' })
  expect(result.messages.map((r) => r.id)).toEqual(['2', '1'])
  expect(result.state.lastSeq).toBe('2')
})

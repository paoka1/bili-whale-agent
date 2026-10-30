// 移植自 upstream/tests/traffic.test.mjs（去掉了依赖 CLI 子进程的用例）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTrafficGuard, normalizeRisk, RISK_DEFAULTS, type RiskSettings, type TrafficGuardOptions } from '../src/traffic.js'

const endpoint = 'https://api.bilibili.com/x/v2/reply/add'
const headers = { cookie: 'SESSDATA=test-secret' }
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
const ok = () => json({ code: 0, data: {} })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function setup(override: Partial<RiskSettings> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-traffic-'))
  dirs.push(dataDir)
  let time = Date.now(), calls = 0
  const options: TrafficGuardOptions = {
    dataDir,
    settings: () => ({ ...RISK_DEFAULTS, ...override }),
    now: () => time,
    sleep: async (ms) => { time += ms },
    transport: async () => { calls++; return ok() },
  }
  return { dataDir, options, guard: createTrafficGuard(options), advance: (ms: number) => { time += ms }, calls: () => calls, time: () => time }
}

it('相同的并发读请求只发一次，响应体各自独立', async () => {
  const s = setup()
  const results = await Promise.all([1, 2, 3].map(() => s.guard.fetch('https://api.bilibili.com/x/web-interface/nav')))
  expect(s.calls()).toBe(1)
  for (const r of results) expect((await r.json()).code).toBe(0)
})

it('读取预算跨实例、跨重启生效，一小时后恢复', async () => {
  const s = setup({ readHourly: 2 })
  await s.guard.fetch('https://api.bilibili.com/x/one')
  await createTrafficGuard(s.options).fetch('https://api.bilibili.com/x/two')
  await expect(s.guard.fetch('https://api.bilibili.com/x/three')).rejects.toThrow(/预算/)
  expect(s.calls()).toBe(2)
  s.advance(3600001)
  await s.guard.fetch('https://api.bilibili.com/x/three')
  expect(s.calls()).toBe(3)
})

it('HTTP 429 + Retry-After 暂停所有接口', async () => {
  const s = setup()
  const guard = createTrafficGuard({ ...s.options, transport: async () => new Response('', { status: 429, headers: { 'retry-after': '1200' } }) })
  await guard.fetch('https://api.bilibili.com/x/one')
  expect(Number(guard.state().until)).toBeGreaterThanOrEqual(s.time() + 1200000)
  await expect(createTrafficGuard(s.options).fetch('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions')).rejects.toThrow(/暂停/)
  expect(s.calls()).toBe(0)
})

it('接口层 -412 也会触发暂停', async () => {
  const s = setup()
  const guard = createTrafficGuard({ ...s.options, transport: async () => json({ code: -412 }) })
  await guard.fetch('https://api.bilibili.com/x/player/wbi/playurl')
  expect(Number(guard.state().until)).toBeGreaterThan(s.time())
})

it('验证码要求人工处理，resume 后恢复', async () => {
  const s = setup()
  const guard = createTrafficGuard({ ...s.options, transport: async () => json({ code: 12015 }) })
  await guard.fetch('https://api.bilibili.com/x/one', { headers })
  await expect(s.guard.fetch('https://api.bilibili.com/x/two', { headers })).rejects.toThrow(/人工/)
  await s.guard.resume(headers)
  await s.guard.fetch('https://api.bilibili.com/x/two', { headers })
  expect(s.calls()).toBe(1)
})

it('结果不确定的写操作跨重启保留，忽略易变字段，禁止重复发送', async () => {
  const s = setup()
  const guard = createTrafficGuard({ ...s.options, transport: async () => { throw new Error('socket closed') } })
  await expect(guard.fetch(endpoint, { method: 'POST', headers, body: 'message=private-text&csrf=old&timestamp=1' })).rejects.toThrow(/结果不确定/)
  s.advance(200000)
  await expect(s.guard.fetch(endpoint, { method: 'POST', headers, body: 'timestamp=2&csrf=new&message=private-text' })).rejects.toThrow(/重复/)
  const [id] = Object.keys(s.guard.state().operations ?? {})
  expect(fs.readFileSync(path.join(s.dataDir, 'traffic-state.json'), 'utf8')).not.toMatch(/private-text|test-secret/)
  await s.guard.resolve(id!, 'not-sent')
  await s.guard.fetch(endpoint, { method: 'POST', headers, body: 'timestamp=3&message=private-text' })
  expect(s.calls()).toBe(1)
  await expect(s.guard.fetch(endpoint, { method: 'POST', headers, body: 'timestamp=4&message=private-text' })).rejects.toMatchObject({ message: expect.stringMatching(/重复/), refusal: true })
})

it('不同的写操作仍受冷却和每日上限约束', async () => {
  const s = setup({ writeDaily: 2 })
  const send = (text: string) => s.guard.fetch(endpoint, { method: 'POST', headers, body: 'message=' + text })
  await send('one')
  await expect(send('two')).rejects.toMatchObject({ message: expect.stringMatching(/冷却/), refusal: true })
  s.advance(120001); await send('two')
  s.advance(120001); await expect(send('three')).rejects.toMatchObject({ message: expect.stringMatching(/预算/), refusal: true })
  expect(s.calls()).toBe(2)
})

it('非 B 站请求不计入预算', async () => {
  const s = setup({ writeDaily: 1 })
  await s.guard.fetch('https://example.test/webhook', { method: 'POST', body: 'one' })
  await s.guard.fetch('https://example.test/webhook', { method: 'POST', body: 'two' })
  expect(s.calls()).toBe(2)
  expect(s.guard.state()).toEqual({})
})

it('状态文件损坏时拒绝请求，而不是重置预算', async () => {
  const s = setup()
  fs.writeFileSync(path.join(s.dataDir, 'traffic-state.json'), '{broken')
  await expect(s.guard.fetch('https://api.bilibili.com/x/one')).rejects.toThrow(/损坏/)
  expect(s.calls()).toBe(0)
})

it('未登录的 nav 不影响公开读取；不同账号互不影响', async () => {
  const s = setup()
  const guard = createTrafficGuard({ ...s.options, transport: async () => json({ code: -101 }) })
  await guard.fetch('https://api.bilibili.com/x/web-interface/nav')
  expect(guard.pauseReason({})).toBeNull()
  await guard.fetch('https://api.bilibili.com/x/web-interface/nav', { headers })
  expect(guard.pauseReason(headers)).toMatch(/人工/)
  expect(guard.pauseReason({ cookie: 'SESSDATA=new-session' })).toBeNull()
})

it('慢请求在多个实例之间同一时刻只有一个在途', async () => {
  const s = setup()
  let active = 0, max = 0, starts = 0
  const options: TrafficGuardOptions = {
    dataDir: s.dataDir,
    settings: () => ({ ...RISK_DEFAULTS, minGapMs: 20 }),
    transport: async () => { active++; starts++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 100)); active--; return ok() },
  }
  await Promise.all([1, 2, 3].map((i) => createTrafficGuard(options).fetch('https://api.bilibili.com/x/test?id=' + i)))
  expect(max).toBe(1)
  expect(starts).toBe(3)
})

it('status 汇总当前账号的用量与暂停原因', async () => {
  const s = setup()
  await s.guard.fetch('https://api.bilibili.com/x/one', { headers })
  expect(s.guard.status(headers)).toEqual({ readDay: 1, writeDay: 0, readHour: 1, writeHour: 0, pausedUntil: null, reason: null })
})

it('normalizeRisk：0 和非法值不能关掉闸门，私信冷却允许 0', () => {
  expect(normalizeRisk({ writeDaily: 0, readHourly: -5, minGapMs: 10, writeGapSec: 1, dmGapSec: 0 })).toEqual({
    ...RISK_DEFAULTS, minGapMs: 500, writeGapSec: 30, dmGapSec: 0,
  })
  expect(normalizeRisk({ writeDaily: 50 }).writeDaily).toBe(50)
})

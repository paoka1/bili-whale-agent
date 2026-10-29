import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as bili from '@bili-whale/bili'
import { ConfigSchema } from '../src/config.js'
import { makePlan } from '../src/night.js'
import * as notifications from '../src/notify.js'
import { createScheduler, pollDelay, type Scheduler } from '../src/scheduler.js'
import type { RunRecord } from '../src/runner.js'
import type { RunKind } from '../src/tools.js'
import { fakeBili } from '../../bili/test/helpers.js'

vi.mock('@bili-whale/bili', async (original) => ({ ...await original<typeof import('@bili-whale/bili')>(), pullInbox: vi.fn(), pullOwnerDms: vi.fn() }))
vi.mock('../src/notify.js', () => ({ notify: vi.fn() }))
const schedulers: Scheduler[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T20:00:00'))
  vi.mocked(bili.pullInbox).mockResolvedValue([])
  vi.mocked(bili.pullOwnerDms).mockResolvedValue({ messages: [], state: { baseline: true, lastSeq: null } })
  vi.mocked(notifications.notify).mockResolvedValue({ ok: true })
})
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.stop(); vi.resetAllMocks(); vi.useRealTimers() })
const record = (patch: Partial<RunRecord> = {}): RunRecord => ({ id: 'run', kind: 'manual', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: 'ok', steps: 1, toolCalls: [], draftsAdded: 0, finalText: '', ...patch })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function setup(patch: unknown = {}) {
  let config = ConfigSchema.parse({ night: { windows: [{ start: '20:00', end: '24:00', wakes: 0 }] }, listen: { dm: false }, ...patch as object })
  const s = fakeBili(() => undefined)
  const run = vi.fn(async (_kind: RunKind, _prompt: string) => record())
  const scheduler = createScheduler({ dataDir: s.dataDir, getConfig: () => config, getCtx: () => ({ ...s.ctx, settings: config, now: Date.now }), run, now: Date.now })
  schedulers.push(scheduler)
  return { ...s, run, scheduler, setConfig: (value: unknown) => { config = ConfigSchema.parse(value) } }
}
const item = (id: string, from: 'owner' | 'other' = 'owner'): bili.InboxItem => ({ id, kind: 'reply', from, mid: from === 'owner' ? '222' : '333', uname: '访客', text: `消息 ${id}`, bvid: 'BV1AAAAAAAAA', oid: '101', root: '8', parent: '9', type: 1, at: Date.now() })

it('运行中手动唤醒排队，重复同类只排一个且从不并发', async () => {
  const s = setup(), first = deferred<RunRecord>()
  s.run.mockImplementationOnce(() => first.promise)
  expect(s.scheduler.wakeNow()).toEqual({ queued: false })
  expect(s.scheduler.wakeNow()).toEqual({ queued: true })
  expect(s.scheduler.wakeNow()).toEqual({ queued: true })
  expect(s.scheduler.status()).toMatchObject({ running: 'manual', queue: ['manual'] })
  expect(s.run).toHaveBeenCalledTimes(1)
  first.resolve(record())
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledTimes(2)
  expect(s.scheduler.status()).toMatchObject({ running: null, queue: [], lastRunAt: expect.any(String) })
})

it('同类消息排队时合并正文，主人与陌生人分开处理', async () => {
  const s = setup({ listen: { comment: true, dm: true, commentIntervalSec: 30 }, owner: { mid: '222' }, self: { mid: '111' } }), first = deferred<RunRecord>()
  s.run.mockImplementationOnce(() => first.promise)
  s.scheduler.wakeNow()
  vi.mocked(bili.pullInbox).mockResolvedValueOnce([item('1'), item('2', 'other')]).mockResolvedValueOnce([item('3')])
  vi.mocked(bili.pullOwnerDms).mockResolvedValueOnce({ messages: [{ id: 'dm', text: '主人私信正文', at: Date.now() }], state: { baseline: true, lastSeq: '1' } })
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(s.scheduler.status().queue).toEqual(['owner-message', 'stranger-message'])
  first.resolve(record())
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run.mock.calls.map(([kind]) => kind)).toEqual(['manual', 'owner-message', 'stranger-message'])
  const prompt = s.run.mock.calls[1]![1]
  expect(prompt).toContain('消息 1')
  expect(prompt).toContain('消息 3')
  expect(prompt).toContain('主人私信正文')
})

it('计划到点执行并持久化完成，重启不重复唤醒', async () => {
  const config = { night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0 }, listen: { dm: false } }
  const s = setup(config), plan = makePlan(ConfigSchema.parse(config).night, {}, Date.now(), () => 0)
  bili.writeJsonAtomic(path.join(s.dataDir, 'whale-night.json'), plan)
  // 计划在 start 时加载，允许构造之后再落盘。
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledWith('wake', expect.stringContaining('20:00–24:00'))
  expect(bili.readJson(path.join(s.dataDir, 'whale-night.json'), {})).toMatchObject({ wakes: 1 })
  s.scheduler.stop()
  const restarted = createScheduler({ dataDir: s.dataDir, getConfig: () => ConfigSchema.parse(config), getCtx: () => s.ctx, run: s.run })
  schedulers.push(restarted)
  restarted.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(s.run).toHaveBeenCalledTimes(1)
})

it('连续定时唤醒只排一个，执行前已过窗口则丢弃', async () => {
  const config = { night: { windows: [{ start: '20:00', end: '20:02', wakes: 2 }], skipChance: 0 }, listen: { dm: false } }
  const s = setup(config), first = deferred<RunRecord>()
  bili.writeJsonAtomic(path.join(s.dataDir, 'whale-night.json'), makePlan(ConfigSchema.parse(config).night, {}, Date.now(), () => 0))
  s.run.mockImplementationOnce(() => first.promise)
  s.scheduler.wakeNow()
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(s.scheduler.status().queue.filter((kind) => kind === 'wake')).toHaveLength(1)
  first.resolve(record())
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledTimes(1)
})

it('跳过看视频仍唤醒写日记，且不要求浏览与分享', async () => {
  const config = { night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 1 }, listen: { dm: false } }
  const s = setup(config)
  bili.writeJsonAtomic(path.join(s.dataDir, 'whale-night.json'), makePlan(ConfigSchema.parse(config).night, {}, Date.now(), () => 0))
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledWith('wake', expect.stringContaining('本次跳过看视频'))
})

it('评论监听失败间隔翻倍，成功后恢复基础间隔', async () => {
  const s = setup({ listen: { comment: true, dm: false, commentIntervalSec: 30 } })
  vi.mocked(bili.pullInbox).mockRejectedValueOnce(new Error('临时失败'))
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(bili.pullInbox).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(bili.pullInbox).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(bili.pullInbox).toHaveBeenCalledTimes(3)
})

it('轮询退避封顶十五分钟，但保留用户更长的间隔', () => {
  expect(pollDelay(30, 8)).toBe(900_000)
  expect(pollDelay(1800, 8)).toBe(1_800_000)
})

it('评论与私信独立退避，重新开启监听会清除旧退避', async () => {
  const config = { listen: { comment: true, dm: true, commentIntervalSec: 30 }, owner: { mid: '222' } }
  const s = setup(config)
  vi.mocked(bili.pullOwnerDms).mockRejectedValue(new Error('私信暂时不可用'))
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(bili.pullInbox).toHaveBeenCalledTimes(2)
  expect(bili.pullOwnerDms).toHaveBeenCalledTimes(1)
  s.setConfig({ ...config, listen: { ...config.listen, dm: false } })
  await vi.advanceTimersByTimeAsync(30_000)
  s.setConfig(config)
  vi.mocked(bili.pullOwnerDms).mockResolvedValue({ messages: [], state: { baseline: true, lastSeq: null } })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(bili.pullOwnerDms).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(bili.pullOwnerDms).toHaveBeenCalledTimes(3)
})

it('慢监听不拖延作息检查，也不重入同一条监听', async () => {
  const config = { night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0 }, listen: { comment: true, dm: false, commentIntervalSec: 30 } }
  const s = setup(config), pending = deferred<bili.InboxItem[]>()
  const plan = makePlan(ConfigSchema.parse(config).night, {}, Date.now(), () => 0)
  bili.writeJsonAtomic(path.join(s.dataDir, 'whale-night.json'), { ...plan, atMs: Date.now() + 30_000 })
  vi.mocked(bili.pullInbox).mockImplementationOnce(() => pending.promise)
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(s.run).toHaveBeenCalledTimes(1)
  expect(bili.pullInbox).toHaveBeenCalledTimes(1)
  pending.resolve([])
  await vi.advanceTimersByTimeAsync(0)
})

it('评论游标取上次开始时间减五分钟，按 kind:id 持久化去重', async () => {
  const s = setup({ listen: { comment: true, dm: false, commentIntervalSec: 30 } }), first = item('1')
  vi.mocked(bili.pullInbox).mockResolvedValue([first])
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(s.run).toHaveBeenCalledTimes(1)
  expect(bili.pullInbox).toHaveBeenLastCalledWith(expect.anything(), { sinceMs: Date.now() - 30_000 - 5 * 60_000 })
  expect(bili.readJson(path.join(s.dataDir, 'inbox-seen.json'), [])).toContain('reply:1')
  s.scheduler.stop()
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledTimes(1)
})

it('去重区分 reply 与 at，持久化只保留最近五百条', async () => {
  const s = setup({ listen: { comment: true, dm: false, commentIntervalSec: 30 } })
  bili.writeJsonAtomic(path.join(s.dataDir, 'inbox-seen.json'), Array.from({ length: 500 }, (_, i) => `reply:${i + 1}`))
  vi.mocked(bili.pullInbox).mockResolvedValueOnce([item('500'), { ...item('500'), kind: 'at', text: '同编号的 @' }, item('501')])
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledTimes(1)
  expect(s.run.mock.calls[0]![1]).toContain('同编号的 @')
  expect(s.run.mock.calls[0]![1]).not.toContain('消息 500')
  const seen = bili.readJson<string[]>(path.join(s.dataDir, 'inbox-seen.json'), [])
  expect(seen).toHaveLength(500)
  expect(seen.slice(-2)).toEqual(['at:500', 'reply:501'])
})

it.each([
  [{ kind: 'wake', finalText: '给主人信：今晚看了猫' }, '她醒来过一次'],
  [{ draftsAdded: 2 }, '有 2 条回复待你审核'],
  [{ status: 'paused', error: '需要验证' }, '请求保护已暂停：需要验证'],
  [{ status: 'login-expired' }, 'B 站登录失效，请在网页重新扫码'],
] as const)('运行结果发送对应通知：%s', async (patch, title) => {
  const s = setup()
  s.run.mockResolvedValue(record(patch))
  if ('kind' in patch && patch.kind === 'wake') {
    const config = ConfigSchema.parse({ night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0 }, listen: { dm: false } })
    s.setConfig(config)
    bili.writeJsonAtomic(path.join(s.dataDir, 'whale-night.json'), makePlan(config.night, {}, Date.now(), () => 0))
    s.scheduler.start()
  } else s.scheduler.wakeNow()
  await vi.advanceTimersByTimeAsync(0)
  expect(notifications.notify).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ title }))
})

it('登录失效后丢弃排队事件且不再运行或轮询，替换凭据后恢复', async () => {
  const s = setup({ listen: { comment: true, dm: false, commentIntervalSec: 30 } }), first = deferred<RunRecord>()
  s.run.mockImplementationOnce(() => first.promise)
  s.scheduler.wakeNow()
  s.scheduler.wakeNow()
  first.resolve(record({ status: 'login-expired' }))
  await vi.advanceTimersByTimeAsync(0)
  s.scheduler.start()
  s.scheduler.wakeNow()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(s.run).toHaveBeenCalledTimes(1)
  expect(bili.pullInbox).not.toHaveBeenCalled()
  s.ctx.cred = { sessdata: 'new-session', bili_jct: 'new-csrf' }
  await vi.advanceTimersByTimeAsync(30_000)
  s.scheduler.wakeNow()
  await vi.advanceTimersByTimeAsync(0)
  expect(s.run).toHaveBeenCalledTimes(2)
})

it('监听同样处理登录失效，停止后不触发后续运行', async () => {
  const s = setup({ listen: { comment: true, dm: false, commentIntervalSec: 30 } })
  vi.mocked(bili.pullInbox).mockRejectedValueOnce(new bili.LoginExpiredError())
  s.scheduler.start()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(bili.pullInbox).toHaveBeenCalledTimes(1)
  expect(notifications.notify).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ title: 'B 站登录失效，请在网页重新扫码' }))
  s.scheduler.stop()
  s.scheduler.wakeNow()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(s.run).not.toHaveBeenCalled()
})

it('stop 等待当前运行完成但不启动已排队的运行，run 拒绝也能清理状态', async () => {
  const s = setup(), first = deferred<RunRecord>()
  s.run.mockImplementationOnce(() => first.promise)
  s.scheduler.wakeNow()
  s.scheduler.wakeNow()
  s.scheduler.stop()
  first.resolve(record())
  await vi.advanceTimersByTimeAsync(60_000)
  expect(s.run).toHaveBeenCalledTimes(1)
  expect(s.scheduler.status()).toMatchObject({ running: null, queue: [] })
  s.scheduler.start()
  s.run.mockRejectedValueOnce(new Error('不应进入日志的凭据'))
  s.scheduler.wakeNow()
  await vi.advanceTimersByTimeAsync(0)
  expect(s.scheduler.status().running).toBeNull()
  expect(JSON.stringify(bili.readLog(s.dataDir))).not.toContain('不应进入日志的凭据')
})

it('损坏的计划不能静默清空每日次数', () => {
  const s = setup()
  fs.writeFileSync(path.join(s.dataDir, 'whale-night.json'), '{broken')
  expect(() => s.scheduler.start()).toThrow('whale-night.json')
})

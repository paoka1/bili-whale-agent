// 移植上游 planner.test.mjs 的作息用例，补上硬间隔与每日总上限。
import { expect, it } from 'vitest'
import { completePlan, historyOf, inWindow, isPending, makePlan, maxWakes, occurrences, type NightConfig } from '../src/night.js'

const time = (s: string) => new Date('2026-10-' + s).getTime()
const cfg = (windows: NightConfig['windows'], skipChance = 0): NightConfig => ({ windows, skipChance })
const night = cfg([{ start: '23:00', end: '01:00', wakes: 1 }])
const random = (...values: number[]) => () => values.shift() ?? 0.5

it('跨午夜计划保留次日时间，重启后不重新抽签', () => {
  const p = makePlan(night, {}, time('21T22:00:00'), random(.75, .9))
  expect(p.atMs).toBe(time('22T00:30:00'))
  expect(makePlan(night, JSON.parse(JSON.stringify(p)), time('22T00:01:00'))).toEqual(p)
  expect(isPending(p, time('22T00:01:00'))).toBe(true)
})

it('跳过决定与时间持久化，后续检查不再随机', () => {
  const c = cfg([{ start: '20:00', end: '24:00', wakes: 1 }], .3)
  const p = makePlan(c, {}, time('21T20:00:00'), random(.5, .1))
  expect(p.action).toBe('skip')
  expect(makePlan(c, p, time('21T20:01:00'), () => { throw Error('不应重抽') })).toEqual(p)
})

it('凌晨优先处理昨天尚未结束的窗口，同一窗口不能跨日重复醒来', () => {
  const c = cfg([...night.windows!, { start: '02:00', end: '03:00', wakes: 1 }])
  const p = makePlan(c, {}, time('21T00:30:00'), random(.5, .9))
  expect(p.window).toBe('23:00–01:00')
  expect(p.endsAt).toBe(time('21T01:00:00'))
  const done = completePlan(makePlan(night, {}, time('21T23:10:00'), () => 0), time('21T23:10:00'))
  expect(makePlan(night, done, time('22T00:10:00'), () => 0).startsAt).toBe(time('22T23:00:00'))
})

it('计划与配置更新不占次数，完成只占一次，跳过也只消耗一次机会', () => {
  const c = cfg([{ start: '20:00', end: '24:00', wakes: 2 }]), now = time('21T20:00:00')
  const p = makePlan({ ...c, skipChance: 1 }, {}, now, () => 0)
  expect(p.usedCount).toEqual({})
  const done = completePlan(p, now)
  expect(done.usedCount[p.windowKey!]).toBe(1)
  expect(done.skippedWindows).toEqual([])
  expect(completePlan(done, now)).toEqual(done)
  const next = makePlan(c, historyOf(done, now), now + 11 * 60_000, () => 0)
  expect(next.withinWindow).toBe('20:00–24:00 第 2/2 次')
  expect(makePlan(c, completePlan(next, now + 11 * 60_000), now + 11 * 60_000).action).toBe('done')
})

it('跳过的不同窗口分别占次数', () => {
  const c = cfg([{ start: '20:00', end: '24:00', wakes: 1 }, { start: '20:00', end: '23:00', wakes: 1 }], 1)
  const now = time('21T20:00:00')
  const first = completePlan(makePlan(c, {}, now, () => 0), now)
  const second = completePlan(makePlan(c, first, now + 11 * 60_000, () => 0), now + 11 * 60_000)
  expect(first.windowKey).not.toBe(second.windowKey)
  expect(makePlan(c, historyOf(second, now), now).action).toBe('done')
})

it('零次禁用窗口，每日总上限可以小于窗口次数之和', () => {
  const c = cfg([{ start: '20:00', end: '24:00', wakes: 0 }])
  expect(maxWakes(c)).toBe(0)
  expect(makePlan(c, {}, time('21T20:00:00')).action).toBe('done')
  const capped = { ...night, maxWakesPerDay: 0 }
  expect(makePlan(capped, {}, time('21T20:00:00')).action).toBe('done')
})

it('过期计划不再投递，第二天正常排计划', () => {
  const c = cfg([{ start: '20:00', end: '21:00', wakes: 1 }])
  const p = makePlan(c, {}, time('21T20:00:00'), () => 0)
  expect(isPending(p, time('21T21:00:00'))).toBe(false)
  const done = makePlan(c, p, time('21T21:00:00'))
  expect(done.action).toBe('done')
  expect(makePlan(c, done, time('22T19:00:00')).action).toBe('wake')
})

it('兼容旧跳过记录并释放尚未执行的唤醒预约', () => {
  const now = time('21T20:00:00')
  expect(historyOf({ date: '2026-10-21', action: 'skip', fired: true, window: '20:00–24:00' }, now).skippedWindows).toEqual(['2026-10-21|20:00–24:00'])
  expect(historyOf({ date: '2026-10-21', action: 'wake', window: '20:00–24:00', usedCount: { '20:00–24:00': 1 } }, now).usedCount['2026-10-21|20:00–24:00']).toBe(0)
})

it('跨午夜窗口包含两侧但不包含结束时刻', () => {
  for (const t of ['21T23:00:00', '22T00:30:00']) expect(inWindow(night, time(t))).toBe(true)
  for (const t of ['21T22:59:00', '22T01:00:00']) expect(inWindow(night, time(t))).toBe(false)
  expect(occurrences(night, time('22T00:30:00'))).toHaveLength(2)
})

it('相邻唤醒遵守硬间隔，窗口放不下则结束', () => {
  const c = cfg([{ start: '20:00', end: '20:15', wakes: 3 }]), now = time('21T20:00:00')
  const done = completePlan(makePlan(c, {}, now, () => 0), now)
  const next = makePlan(c, done, now, () => 0)
  expect(next.atMs).toBe(now + 10 * 60_000)
  expect(makePlan(c, completePlan(next, next.atMs!), next.atMs!).action).toBe('done')
})

// 移植 upstream/tools/lib/night-plan.mjs；比较绝对的本地日历时间，保留跨午夜与夏令时语义。
export type NightConfig = {
  windows?: { start: string; end: string; wakes?: number }[]
  windowStart?: string; windowEnd?: string; maxWakesPerDay?: number
  skipChance?: number; minGapMin?: number; maxVideos?: number
}
export type NightHistory = {
  schema: number; date: string; wakes: number; wokeAt: string | null
  usedCount: Record<string, number>; skippedWindows: string[]
}
export type NightState = Partial<NightHistory> & {
  action?: 'wake' | 'skip' | 'done'; done?: boolean; reason?: string; fired?: boolean; woke?: boolean
  atMs?: number; at?: number; atText?: string; window?: string; windowKey?: string
  startsAt?: number; endsAt?: number; withinWindow?: string; maxVideos?: number; createdAt?: string; roll?: string
}
export type NightPlan = NightHistory & NightState

export const dayOf = (value: number | Date = Date.now()): string => new Date(value).toLocaleDateString('sv-SE')
const stamp = (day: string, minutes: number): number => {
  const date = new Date(`${day}T00:00:00`)
  date.setMinutes(minutes)
  return date.getTime()
}
const parse = (text: string): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) throw new Error(`无效作息时间：${text}`)
  const h = Number(match[1]), m = Number(match[2])
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`无效作息时间：${text}`)
  return h * 60 + m
}

export function windowsOf(cfg: NightConfig) {
  const list = cfg.windows ?? [{ start: cfg.windowStart ?? '20:00', end: cfg.windowEnd ?? '24:00', wakes: cfg.maxWakesPerDay ?? 1 }]
  return list.map((w) => {
    const start = parse(w.start), rawEnd = parse(w.end)
    const end = rawEnd <= start ? rawEnd + 1440 : rawEnd
    return { start, end, wrap: end > 1440, label: `${w.start}–${w.end}`, wakes: Math.min(12, Math.max(0, Math.floor(Number(w.wakes ?? 1) || 0))) }
  })
}

// AppConfig 允许另设每日总上限；不能仅用各窗口次数之和覆盖它。
export const maxWakes = (cfg: NightConfig): number => Math.min(12, cfg.maxWakesPerDay ?? 12, windowsOf(cfg).reduce((n, w) => n + w.wakes, 0))
export function occurrences(cfg: NightConfig, now = Date.now()) {
  const today = dayOf(now), yesterday = new Date(`${today}T00:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  return windowsOf(cfg).flatMap((w) => (w.wrap ? [dayOf(yesterday), today] : [today]).map((day) => ({
    ...w, key: `${day}|${w.label}`, startsAt: stamp(day, w.start), endsAt: stamp(day, w.end),
  }))).filter((w) => w.endsAt > now)
}
export const inWindow = (cfg: NightConfig, now = Date.now()): boolean => occurrences(cfg, now).some((w) => w.startsAt <= now)

/** 配置变更只丢弃待执行计划，按窗口日期记录的历史保留；兼容旧版预约计数。 */
export function historyOf(state: NightState = {}, now = Date.now()): NightHistory {
  const usedCount = { ...(state.usedCount ?? {}) }
  const skippedWindows = new Set(state.skippedWindows ?? [])
  if (state.schema !== 2 && state.date) {
    for (const [label, count] of Object.entries(usedCount)) {
      if (!label.includes('|')) {
        const reserved = state.action === 'wake' && !state.fired && !state.woke && label === state.window ? 1 : 0
        usedCount[`${state.date}|${label}`] = Math.max(0, count - reserved)
        delete usedCount[label]
      }
    }
    if (state.action === 'skip' && state.fired && state.window) skippedWindows.add(`${state.date}|${state.window}`)
  }
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 3)
  for (const key of Object.keys(usedCount)) if (key.slice(0, 10) < dayOf(cutoff)) delete usedCount[key]
  return { schema: 2, date: dayOf(now), wakes: state.date === dayOf(now) ? state.wakes ?? 0 : 0,
    wokeAt: state.wokeAt ?? null, usedCount, skippedWindows: [...skippedWindows].filter((key) => key.slice(0, 10) >= dayOf(cutoff)) }
}

export function isPending(state: NightState | null | undefined, now = Date.now()): boolean {
  return state?.schema === 2 && (state.action === 'wake' || state.action === 'skip') && !state.fired && !state.woke
    && Number.isFinite(state.atMs) && Number.isFinite(state.endsAt) && state.endsAt! > now
}

export function makePlan(cfg: NightConfig, state: NightState = {}, now = Date.now(), random = Math.random): NightPlan {
  if (isPending(state, now)) return state as NightPlan
  const history = historyOf(state, now)
  const done = (reason: string): NightPlan => ({ ...history, action: 'done', done: true, reason })
  if (history.wakes >= maxWakes(cfg)) return done('今天醒来次数已用完（或所有窗口为零次）')
  // 2026-10-22 上游修复：skip 只消耗一次机会，不能把整段窗口拉黑。
  const pool = occurrences(cfg, now).filter((w) => w.wakes > (history.usedCount[w.key] ?? 0))
    .sort((a, b) => a.endsAt - b.endsAt || a.startsAt - b.startsAt)
  if (!pool.length) return done('今天可用窗口已结束或已经处理')
  const lastWoke = Number.isFinite(Date.parse(state.wokeAt ?? '')) ? Date.parse(state.wokeAt!) : 0
  const minGapMs = Math.max(60_000, Math.floor((cfg.minGapMin ?? 10) * 60_000))
  for (const w of pool) {
    // 2026-10-22 上游修复：间隔是硬下限，窗口挤不下就少醒几次，不自动压缩。
    const from = Math.max(now, w.startsAt, lastWoke + minGapMs)
    if (from >= w.endsAt - 30_000) continue
    const atMs = from + Math.floor(random() * Math.max(1, w.endsAt - from))
    const atDate = new Date(atMs), at = atDate.getHours() * 60 + atDate.getMinutes()
    const skip = random() < Math.min(1, Math.max(0, cfg.skipChance ?? 0.3))
    return { ...history, action: skip ? 'skip' : 'wake', fired: false, atMs, at,
      atText: `${dayOf(atMs)} ${String(atDate.getHours()).padStart(2, '0')}:${String(atDate.getMinutes()).padStart(2, '0')}`,
      window: w.label, windowKey: w.key, startsAt: w.startsAt, endsAt: w.endsAt,
      withinWindow: `${w.label} 第 ${(history.usedCount[w.key] ?? 0) + 1}/${w.wakes} 次`,
      maxVideos: cfg.maxVideos ?? 5, createdAt: new Date(now).toISOString(),
      ...(skip ? { reason: '本次计划跳过看视频，仍写日记' } : { roll: 'watch' }) }
  }
  return done('今天可用窗口里已经排不下下一次（间隔不够）')
}

export function completePlan(state: NightState, now = Date.now()): NightPlan {
  if (state.fired) return state as NightPlan
  const h = historyOf(state, now)
  if (!state.windowKey) throw new Error('计划缺少窗口标识，请重新 plan')
  if (state.action === 'skip' || state.action === 'wake') {
    h.usedCount[state.windowKey] = (h.usedCount[state.windowKey] ?? 0) + 1
    h.wakes++
  }
  return { ...state, ...h, fired: true, woke: state.action === 'wake', wokeAt: new Date(now).toISOString() }
}

// 作息、监听与推送共用一个运行队列；定时器只负责投递，不并发运行 agent。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'
import {
  appendLog, createTrafficGuard, dataPath, loadCred, LoginExpiredError, pullInbox, pullOwnerDms, readJsonl,
  TrafficError, writeJsonAtomic, type BiliContext, type InboxItem,
} from '@bili-whale/bili'
import type { AppConfig } from './config.js'
import { completePlan, historyOf, isPending, makePlan, MAX_RETRIES, retryPlan, type NightState } from './night.js'
import { notify, type Notification } from './notify.js'
import { messagePrompt, wakePrompt } from './prompts.js'
import type { RunRecord, ToolCallRecord } from './runner.js'
import type { RunKind } from './tools.js'

export interface Scheduler {
  start(): void
  stop(): void
  wakeNow(): { queued: boolean }
  status(): { running: RunKind | null; progress: ToolCallRecord[]; queue: RunKind[]; nextWakeAt: number | null; nextWindow: string | null; lastRunAt: string | null }
}
export type SchedulerDeps = {
  dataDir: string; getConfig: () => AppConfig; run: (kind: RunKind, prompt: string, onToolCall?: (call: ToolCallRecord) => void) => Promise<RunRecord>
  now?: () => number; setTimer?: typeof setTimeout
  // 服务可复用 agent 的上下文；未提供时从配置与凭据文件创建，保持计划中的最小调用接口。
  getCtx?: () => BiliContext
}

const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)))
const nightState = z.object({
  schema: z.number().int().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  wakes: z.number().int().nonnegative().optional(), wokeAt: timestamp.nullable().optional(),
  usedCount: z.record(z.string(), z.number().int().nonnegative()).optional(), skippedWindows: z.array(z.string()).optional(),
  action: z.enum(['wake', 'skip', 'done']).optional(), done: z.boolean().optional(), reason: z.string().optional(),
  fired: z.boolean().optional(), woke: z.boolean().optional(), atMs: z.number().optional(), at: z.number().optional(),
  atText: z.string().optional(), window: z.string().optional(), windowKey: z.string().optional(),
  startsAt: z.number().optional(), endsAt: z.number().optional(), withinWindow: z.string().optional(),
  maxVideos: z.number().int().nonnegative().optional(), createdAt: timestamp.optional(), roll: z.string().optional(),
  retries: z.number().int().nonnegative().optional(),
}).refine((s) => s.schema !== 2 || s.fired || s.woke || !['wake', 'skip'].includes(s.action ?? '')
  || (s.atMs !== undefined && s.endsAt !== undefined && !!s.window && !!s.windowKey))

/** 本地文件也是输入边界；损坏的计划不能当成首次启动而重置次数。 */
function readFile<T>(dataDir: string, name: string, schema: z.ZodType<T>, fallback: T): T {
  try { return schema.parse(JSON.parse(fs.readFileSync(dataPath(dataDir, name), 'utf8').replace(/^\uFEFF/, ''))) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw new Error(`${name} 无法读取或已损坏，请检查本地状态`)
  }
}

/** 沿用上游 poll-policy：空结果不退避，只有失败翻倍，最多十五分钟（更长配置优先）。 */
export function pollDelay(baseSeconds: number, failureRounds = 0): number {
  const base = Number.isFinite(baseSeconds) && baseSeconds > 0 ? Math.max(15, baseSeconds) : 60
  const rounds = Number.isFinite(failureRounds) ? Math.min(8, Math.max(0, failureRounds)) : 0
  return Math.min(Math.max(base, 900), base * 2 ** rounds) * 1000
}

type Message = InboxItem | { text: string }
type Event = { kind: RunKind; items?: Message[]; plan?: NightState }
type Poll = { nextAt: number; failures: number; busy: boolean; config: string }

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { dataDir, getConfig } = deps
  const now = deps.now ?? Date.now, setTimer = deps.setTimer ?? setTimeout
  const guard = createTrafficGuard({ dataDir, settings: () => getConfig().risk, now })
  const getCtx = deps.getCtx ?? (() => ({ dataDir, settings: getConfig(), cred: loadCred(dataDir) ?? { sessdata: '', bili_jct: '' }, guard, dryRun: getConfig().dryRun, now }))
  const fingerprint = (ctx: BiliContext) => createHash('sha256').update(JSON.stringify(ctx.cred)).digest('hex')
  let active = false, stopped = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
  let running: RunKind | null = null, progress: ToolCallRecord[] = [], lastRunAt: string | null = null, invalidLogin: string | null = null
  let state: NightState = {}, nightConfig = '', loaded = false
  let seen = new Set<string>(), lastCommentStart = Math.max(0, now() - 24 * 60 * 60_000)
  const queue: Event[] = [], comment: Poll = { nextAt: 0, failures: 0, busy: false, config: '' }, dm: Poll = { nextAt: 0, failures: 0, busy: false, config: '' }

  function load(): void {
    state = readFile(dataDir, 'whale-night.json', nightState, {})
    seen = new Set(readFile(dataDir, 'inbox-seen.json', z.array(z.string().regex(/^(reply|at):\d+$/)), []).slice(-500))
    const last = readJsonl<{ endedAt?: unknown }>(dataPath(dataDir, 'runs.jsonl'), 1)[0]?.endedAt
    lastRunAt = typeof last === 'string' && Number.isFinite(Date.parse(last)) ? last : lastRunAt
    nightConfig = JSON.stringify(getConfig().night)
    loaded = true
  }
  function savePlan(next: NightState): void {
    if (JSON.stringify(next) !== JSON.stringify(state)) writeJsonAtomic(dataPath(dataDir, 'whale-night.json'), next)
    state = next
  }
  function refreshPlan(): void {
    const cfg = getConfig(), key = JSON.stringify(cfg.night)
    savePlan(makePlan(cfg.night, key === nightConfig ? state : historyOf(state, now()), now()))
    nightConfig = key
  }
  function suspended(): boolean {
    if (invalidLogin === null) return false
    const ctx = getCtx()
    if (!ctx.cred.sessdata || !ctx.cred.bili_jct || fingerprint(ctx) === invalidLogin) return true
    invalidLogin = null
    comment.nextAt = dm.nextAt = 0
    comment.failures = dm.failures = 0
    return false
  }
  function suspend(ctx: BiliContext): void {
    invalidLogin = fingerprint(ctx)
    queue.length = 0
  }
  // 后台任务不能因为日志目录暂时不可写而留下未处理的 Promise 拒绝。
  const logFailure = (note: string) => {
    try { appendLog(dataDir, { kind: 'scheduler', target: null, note }) } catch { /* 本地存储故障，保留现有状态供下次重试 */ }
  }
  async function send(cfg: AppConfig, ctx: BiliContext, msg: Notification): Promise<void> {
    try {
      const result = await notify(cfg, ctx, msg)
      if (!result.ok) logFailure('消息推送未完成，请检查推送配置、登录与请求保护状态')
    } catch { logFailure('消息推送未完成，请检查推送配置') }
  }
  async function afterRun(record: RunRecord, ctx: BiliContext): Promise<void> {
    const cfg = getConfig()
    if (record.status === 'login-expired') suspend(ctx)
    // 手动唤醒和定时醒来一样以给主人的信结尾，一样推送
    if ((record.kind === 'wake' || record.kind === 'manual') && record.status === 'ok' && record.finalText.trim()) await send(cfg, ctx, { title: '她醒来过一次', text: record.finalText })
    if (record.draftsAdded > 0) await send(cfg, ctx, { title: `有 ${record.draftsAdded} 条回复待你审核`, text: '请到网页的活动页审核回复草稿。' })
    if (record.status === 'paused') await send(cfg, ctx, { title: `请求保护已暂停：${record.error || '请检查请求保护状态'}`, text: '请在网页查看活动与请求保护状态，处理后再继续。' })
    if (record.status === 'login-expired') await send(cfg, ctx, { title: 'B 站登录失效，请在网页重新扫码', text: '调度已暂停，重新登录后恢复。' })
  }
  function silenceDays(): number {
    const feedback = readFile(dataDir, 'feedback.json', z.object({ last: timestamp.optional() }), {})
    return feedback.last ? Math.max(0, Math.floor((now() - Date.parse(feedback.last)) / 86_400_000)) : 0
  }
  function promptFor(event: Event): string {
    if (event.items) return messagePrompt(event.kind as 'owner-message' | 'stranger-message', event.items)
    const cfg = getConfig(), plan = event.plan
    if (plan?.action === 'skip') return `【醒来】本次窗口：${plan.window}。本次跳过看视频，不浏览、收藏或主动分享；先 diary_read，延续两本日记，再用 log 记录感受。最后写给主人信，由程序推送。`
    return wakePrompt(cfg, { window: plan?.window ?? '手动唤醒', maxVideos: plan?.maxVideos ?? cfg.night.maxVideos, silenceDays: silenceDays() })
  }
  async function drain(): Promise<void> {
    if (running || stopped) return
    try { if (suspended()) return } catch { logFailure('无法读取登录状态，请检查配置与本地状态'); return }
    const event = queue.shift()
    if (!event) return
    // 等待期间可能跨过窗口或保存了新配置，旧的定时事件不能在此时执行。
    if (event.plan && (!isPending(event.plan, now()) || event.plan.atMs !== state.atMs || event.plan.windowKey !== state.windowKey)) {
      void drain()
      return
    }
    running = event.kind
    let ctx: BiliContext | undefined
    try {
      ctx = getCtx()
      const prompt = promptFor(event)
      // 先落盘再交付，重启不会再次投递同一计划；排队本身不消耗机会。
      if (event.plan) savePlan(completePlan(event.plan, now()))
      const record = await deps.run(event.kind, prompt, (call) => progress.push(call))
      lastRunAt = record.endedAt
      const retry = event.plan && record.status === 'failed' && record.steps === 0 ? retryPlan(event.plan, now()) : null
      if (retry) {
        savePlan(retry)
        logFailure(`醒来失败（${(record.error ?? '未知原因').slice(0, 120)}），${retry.atText!.slice(11)} 再试一次（第 ${retry.retries}/${MAX_RETRIES} 次）`)
      }
      await afterRun(record, ctx)
    } catch (e) {
      if (e instanceof LoginExpiredError && ctx) {
        suspend(ctx)
        await send(getConfig(), ctx, { title: 'B 站登录失效，请在网页重新扫码', text: '调度已暂停，重新登录后恢复。' })
      } else logFailure('运行未完成，请检查运行记录、配置与本地状态')
    } finally {
      running = null
      progress = []
      if (loaded && !stopped) {
        try { refreshPlan() } catch { logFailure('作息计划更新失败，请检查 whale-night.json 与配置') }
      }
      void drain()
    }
  }
  function enqueue(event: Event): void {
    const existing = queue.find((item) => item.kind === event.kind)
    if (existing) {
      if (event.items) existing.items = [...existing.items ?? [], ...event.items]
    } else queue.push(event)
    void drain()
  }
  async function poll(source: 'comment' | 'dm', ctx: BiliContext, token: number): Promise<void> {
    const cfg = getConfig(), policy = source === 'comment' ? comment : dm
    if (policy.busy) return
    const key = `${cfg.listen[source]}:${cfg.listen.commentIntervalSec}`
    if (policy.config !== key) {
      policy.config = key
      policy.nextAt = policy.failures = 0
    }
    if (!cfg.listen[source] || now() < policy.nextAt || !ctx.cred.sessdata || (source === 'dm' && !cfg.owner.mid)) return
    policy.busy = true
    const started = now()
    try {
      if (source === 'comment') {
        const items = await pullInbox(ctx, { sinceMs: Math.max(0, lastCommentStart - 5 * 60_000) })
        if (!active || token !== generation || !getConfig().listen.comment || suspended()) return
        const fresh = items.filter((item) => !seen.has(`${item.kind}:${item.id}`))
        const next = new Set([...seen, ...fresh.map((item) => `${item.kind}:${item.id}`)].slice(-500))
        writeJsonAtomic(dataPath(dataDir, 'inbox-seen.json'), [...next])
        seen = next
        lastCommentStart = started
        for (const from of ['owner', 'other'] as const) {
          const batch = fresh.filter((item) => item.from === from)
          if (batch.length) enqueue({ kind: from === 'owner' ? 'owner-message' : 'stranger-message', items: batch })
        }
      } else {
        // 私信模块内部已合并持久化游标；这里只传首次基线，不另存第二份已读状态。
        const result = await pullOwnerDms(ctx, { baseline: false, lastSeq: null })
        if (!active || token !== generation || !getConfig().listen.dm || suspended()) return
        if (result.messages.length) enqueue({ kind: 'owner-message', items: result.messages })
      }
      policy.failures = 0
    } catch (e) {
      if (!active || token !== generation) return
      policy.failures++
      if (e instanceof LoginExpiredError) {
        suspend(ctx)
        await send(cfg, ctx, { title: 'B 站登录失效，请在网页重新扫码', text: '调度已暂停，重新登录后恢复。' })
      } else if (e instanceof TrafficError && !e.refusal) {
        // 人工暂停可能持续数小时，只在这轮连续失败的第一次推送，退避重试期间不重复打扰
        if (policy.failures === 1) await send(cfg, ctx, { title: `请求保护已暂停：${e.message}`, text: '监听暂时退避，请检查请求保护状态。' })
      } else {
        // bili 包的错误信息已去掉凭据，写上原因才查得出问题
        const reason = String((e as Error)?.message ?? '未知错误').slice(0, 200)
        logFailure(`${source === 'comment' ? '评论监听' : '主人私信监听'}失败，稍后自动重试：${reason}`)
      }
    } finally {
      policy.busy = false
      policy.nextAt = now() + pollDelay(cfg.listen.commentIntervalSec, policy.failures)
    }
  }
  function tick(token: number): void {
    try {
      if (!active || token !== generation || suspended()) return
      refreshPlan()
      if (isPending(state, now()) && state.atMs! <= now()) enqueue({ kind: 'wake', plan: state })
      const ctx = getCtx()
      // 网络慢时仍每三十秒检查作息；每条监听各自防重入，互不拖延。
      for (const source of ['comment', 'dm'] as const) {
        void poll(source, ctx, token).catch(() => logFailure('监听检查失败，请检查配置与本地状态'))
      }
    } catch { logFailure('调度检查失败，请检查配置与本地状态') }
    finally {
      if (active && token === generation) timer = setTimer(() => tick(token), 30_000)
    }
  }

  return {
    start() {
      if (active) return
      load()
      active = true
      stopped = false
      tick(++generation)
    },
    stop() {
      active = false
      stopped = true
      generation++
      if (timer !== undefined) clearTimeout(timer)
      queue.length = 0
    },
    wakeNow() {
      const queued = running !== null || queue.length > 0 || stopped || suspended()
      if (!stopped && !suspended()) enqueue({ kind: 'manual' })
      return { queued }
    },
    status() {
      const pending = !stopped && !suspended() && isPending(state, now())
      return { running, progress: [...progress], queue: queue.map((event) => event.kind), nextWakeAt: pending ? state.atMs! : null,
        nextWindow: pending ? state.window ?? null : null, lastRunAt }
    },
  }
}

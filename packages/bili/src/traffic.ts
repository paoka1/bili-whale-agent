// 请求保护：读写预算、写入冷却、风控暂停与退避、重复写入拦截。
// 移植自 upstream/tools/lib/traffic.mjs。状态与锁放在数据目录里，多个实例共享同一份预算。
// 锁只保护「预约 / 记账」，不包住网络请求本身。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isBiliApiHost } from './net.js'

export type RiskSettings = {
  minGapMs: number
  readHourly: number
  readDaily: number
  writeHourly: number
  writeDaily: number
  writeGapSec: number
  dmGapSec: number
}

export const RISK_DEFAULTS: RiskSettings = { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 }

/** 用户配置 → 生效值。0 或非法值当作没填（防止手滑关掉闸门），私信冷却允许 0。 */
export function normalizeRisk(partial: Partial<Record<keyof RiskSettings, unknown>> = {}): RiskSettings {
  const result = { ...RISK_DEFAULTS }
  for (const key of Object.keys(result) as (keyof RiskSettings)[]) {
    const n = Number(partial[key])
    if (Number.isFinite(n) && (n > 0 || (key === 'dmGapSec' && n === 0))) result[key] = Math.floor(n)
  }
  result.minGapMs = Math.max(500, result.minGapMs)
  result.writeGapSec = Math.max(30, result.writeGapSec)
  return result
}

export class TrafficError extends Error {
  readonly code = 'BILI_TRAFFIC_PAUSED'
  cooldownMs?: number
  constructor(message: string) {
    super(message)
    this.name = 'TrafficError'
  }
}

type AccountState = { date?: string; readDay?: number; writeDay?: number; hourAt?: number; readHour?: number; writeHour?: number; lastWrite?: number }
type Operation = { at: number; status: 'pending' | 'confirmed' | 'unknown'; endpoint: string }
export type TrafficState = {
  accounts?: Record<string, AccountState>
  operations?: Record<string, Operation>
  manual?: Record<string, { at: number; code: number }>
  until?: number
  streak?: number
  reason?: string
  riskEndpoint?: string
  nextAt?: number
  lastDispatch?: number
  active?: { token: string; pid: number; until: number }
  last?: { at: number; endpoint: string; method: string; http: number; code: number | null }
}

export type TrafficStatus = { readDay: number; writeDay: number; readHour: number; writeHour: number; pausedUntil: number | null; reason: string | null }

export type GuardInit = RequestInit & { waitWriteMs?: number }
export type Transport = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface TrafficGuard {
  fetch(input: string | URL, init?: GuardInit): Promise<Response>
  /** 原始状态（排障与测试用） */
  state(): TrafficState
  status(headers?: HeadersInit): TrafficStatus
  pauseReason(headers?: HeadersInit): string | null
  /** 人工处理完验证码 / 重新登录后解除该账号的人工暂停 */
  resume(headers?: HeadersInit): Promise<void>
  /** 核查过结果不确定的写操作后，标记为已发送或未发送 */
  resolve(id: string, outcome: 'confirmed' | 'not-sent'): Promise<void>
}

export type TrafficGuardOptions = {
  dataDir: string
  settings: () => RiskSettings
  transport?: Transport
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const RISK_CODES = [-412, -352, -799, -509, -10403]
const MANUAL_CODES = [12015, -105]
const IGNORED_FIELDS = /^(csrf|csrf_token|wts|w_rid|rnd|timestamp|msg\[timestamp\]|msg\[dev_id\])$/

export function createTrafficGuard(opt: TrafficGuardOptions): TrafficGuard {
  const transport: Transport = opt.transport ?? ((input, init) => globalThis.fetch(input, init))
  const now = opt.now ?? Date.now
  const sleep = opt.sleep ?? ((ms: number) => delay(ms).then(() => undefined))
  const stateFile = path.join(opt.dataDir, 'traffic-state.json')
  const lockFile = stateFile + '.lock'

  function read(): TrafficState {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (!s || typeof s !== 'object') throw new Error('invalid state')
      return s
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new TrafficError('请求保护状态损坏，请检查 traffic-state.json；已停止网络请求')
    }
  }

  async function locked<T>(fn: (s: TrafficState) => T): Promise<T> {
    fs.mkdirSync(opt.dataDir, { recursive: true })
    const deadline = Date.now() + 10000
    let fd: number | undefined
    while (fd === undefined) {
      try {
        fd = fs.openSync(lockFile, 'wx')
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs
          let pid: unknown
          try { pid = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid } catch { /* 锁文件可能刚创建还没写完 */ }
          if ((isPid(pid) && !alive(pid)) || (!pid && age > 10000)) { fs.unlinkSync(lockFile); continue }
        } catch { /* 别的实例刚释放了锁 */ }
        if (Date.now() >= deadline) throw new TrafficError('请求保护锁繁忙，本次停止；请稍后再试')
        await delay(25)
      }
    }
    try {
      const s = read()
      const result = fn(s)
      const temp = `${stateFile}.${process.pid}.tmp`
      try {
        fs.writeFileSync(temp, JSON.stringify(s))
        fs.renameSync(temp, stateFile)
      } finally {
        fs.rmSync(temp, { force: true })
      }
      return result
    } finally {
      fs.closeSync(fd)
      fs.unlinkSync(lockFile)
    }
  }

  function blocked(s: TrafficState, account: string): void {
    if (s.manual?.[account]) throw new TrafficError('账号需要人工处理登录或验证码，处理后在网页上恢复')
    if (Number(s.until ?? 0) > now()) throw new TrafficError(`请求已暂停，${new Date(Number(s.until)).toISOString()} 后再试（${s.reason ?? '平台限制'}）`)
  }

  function identity(headers?: HeadersInit): string {
    const cookie = new Headers(headers).get('cookie') ?? ''
    return digest(((cookie.match(/(?:^|;)\s*SESSDATA=([^;]*)/i) ?? [])[1] ?? cookie) || 'anonymous')
  }

  // 写操作的指纹：去掉每次都变的字段，同一条内容重复提交会被认出来；只存哈希，不存正文
  function fingerprint(url: URL, body: unknown): string {
    const raw = body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : null
    if (raw === null) return digest(url.pathname + ':' + String(body))
    let value: string
    try {
      value = JSON.stringify(JSON.parse(raw), (k, v) => (IGNORED_FIELDS.test(k) ? undefined : v))
    } catch {
      value = new URLSearchParams([...new URLSearchParams(raw)].filter(([k]) => !IGNORED_FIELDS.test(k)).sort(([a], [b]) => a.localeCompare(b))).toString()
    }
    return digest(url.origin + url.pathname + ':' + value)
  }

  async function guarded(input: string | URL, init: GuardInit = {}): Promise<Response> {
    const url = new URL(input)
    const { waitWriteMs, ...requestInit } = init
    if (!isBiliApiHost(url)) return transport(input, requestInit)
    const headers = requestInit.headers ?? {}
    const account = identity(headers)
    const method = String(requestInit.method ?? 'GET').toUpperCase()
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method)
    const id = writing ? account.slice(0, 16) + ':' + fingerprint(url, requestInit.body) : null
    const cfg = opt.settings()
    const waitDeadline = now() + Math.min(180000, Math.max(0, Number(waitWriteMs) || 0))
    const requestToken = crypto.randomUUID()

    let reservation: { slot: number }
    for (;;) {
      const timestamp = now()
      try {
        reservation = await locked((s) => {
          blocked(s, account)
          s.accounts ??= {}
          s.operations ??= {}
          const a = (s.accounts[account] ??= {})
          const date = new Date(timestamp).toLocaleDateString('sv-SE')
          if (a.date !== date) Object.assign(a, { date, readDay: 0, writeDay: 0 })
          if (!a.hourAt || timestamp - a.hourAt >= 3600000) Object.assign(a, { hourAt: timestamp, readHour: 0, writeHour: 0 })
          for (const [key, item] of Object.entries(s.operations)) {
            if (item.status !== 'unknown' && item.status !== 'pending' && timestamp - item.at > 86400000) delete s.operations[key]
          }
          if (writing) {
            if (s.operations[id!]) throw new TrafficError(`相同操作已提交或结果待核查，禁止重复发送；操作 ID：${id}`)
            if (Object.keys(s.operations).length >= 2000) throw new TrafficError('发送记录已满，请先核查未确认操作')
            const gap = (url.pathname.endsWith('/send_msg') ? cfg.dmGapSec : cfg.writeGapSec) * 1000
            if (a.lastWrite && timestamp - a.lastWrite < gap && !url.pathname.endsWith('/reply/del')) {
              throw Object.assign(new TrafficError('写操作冷却中，请稍后再发送'), { cooldownMs: a.lastWrite + gap - timestamp })
            }
            if ((a.writeHour ?? 0) >= cfg.writeHourly || (a.writeDay ?? 0) >= cfg.writeDaily) throw new TrafficError('已达到本地写操作预算，本次不发送')
          } else if ((a.readHour ?? 0) >= cfg.readHourly || (a.readDay ?? 0) >= cfg.readDaily) {
            throw new TrafficError('已达到本地读取预算，请等待预算窗口恢复')
          }
          const slot = Math.max(timestamp, Number(s.nextAt ?? 0))
          if (slot - timestamp > 30000) throw new TrafficError('请求队列已满，本次停止')
          s.nextAt = slot + cfg.minGapMs
          if (writing) {
            a.writeHour = (a.writeHour ?? 0) + 1
            a.writeDay = (a.writeDay ?? 0) + 1
            a.lastWrite = timestamp
            s.operations[id!] = { at: timestamp, status: 'pending', endpoint: url.pathname }
          } else {
            a.readHour = (a.readHour ?? 0) + 1
            a.readDay = (a.readDay ?? 0) + 1
          }
          return { slot }
        })
        break
      } catch (e) {
        const cooldownMs = (e as TrafficError).cooldownMs
        if (!cooldownMs || !waitWriteMs || now() + cooldownMs > waitDeadline) throw e
        await sleep(cooldownMs)
        requestInit.signal?.throwIfAborted()
      }
    }

    let dispatched = false
    try {
      await sleep(Math.max(0, reservation.slot - now()))
      requestInit.signal?.throwIfAborted()
      // 跨实例：同一时刻只允许一个请求在途，且两次发出之间至少隔 minGapMs
      for (;;) {
        const wait = await locked((s) => {
          blocked(s, account)
          if (s.active && Number(s.active.until) > now() && alive(s.active.pid)) return 100
          const remaining = Math.max(0, Number(s.lastDispatch ?? 0) + cfg.minGapMs - now())
          if (!remaining) {
            s.lastDispatch = now()
            s.active = { token: requestToken, pid: process.pid, until: now() + 35000 }
          }
          return remaining
        })
        if (!wait) break
        await sleep(wait)
        requestInit.signal?.throwIfAborted()
      }
      const signal = requestInit.signal ? AbortSignal.any([requestInit.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
      dispatched = true
      const response = await transport(input, { ...requestInit, signal })
      let payload: { code?: unknown } | undefined
      if ((response.headers.get('content-type') ?? '').includes('json')) {
        try { payload = await response.clone().json() } catch { /* 正文不是 JSON */ }
      }
      const code = Number(payload?.code)
      const risk = [412, 429].includes(response.status) || RISK_CODES.includes(code)
      const session = (new Headers(headers).get('cookie')?.match(/(?:^|;)\s*SESSDATA=([^;]+)/i) ?? [])[1]
      const authenticated = !!session && !['undefined', 'null'].includes(session)
      const manual = MANUAL_CODES.includes(code) || (authenticated && (code === -101 || response.status === 401))
      const retry = response.headers.get('retry-after')
      const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now())) : 0
      await locked((s) => {
        if (s.active?.token === requestToken) delete s.active
        if (risk) {
          // 风控：暂停所有接口，5 分钟起指数退避，封顶 30 分钟（Retry-After 更长时以它为准）
          s.streak = Math.min(8, Number(s.streak ?? 0) + 1)
          s.until = Math.max(Number(s.until ?? 0), now() + Math.max(Number.isFinite(retryMs) ? retryMs : 0, Math.min(1800000, 300000 * 2 ** (s.streak - 1))))
          s.reason = `HTTP ${response.status} / code ${Number.isFinite(code) ? code : 'unknown'}`
          s.riskEndpoint = url.pathname
        } else if (code === 0 && s.riskEndpoint === url.pathname && now() >= Number(s.until ?? 0)) {
          s.streak = 0
        }
        if (manual) {
          s.manual ??= {}
          s.manual[account] = { at: now(), code: Number.isFinite(code) ? code : response.status }
        }
        if (id && s.operations?.[id]) {
          if (response.ok && code === 0) s.operations[id].status = 'confirmed'
          else if (payload && Number.isFinite(code) && code !== 0) delete s.operations[id]
          else s.operations[id].status = 'unknown'
        }
        s.last = { at: now(), endpoint: url.pathname, method, http: response.status, code: Number.isFinite(code) ? code : null }
      })
      return response
    } catch (e) {
      await locked((s) => {
        if (s.active?.token === requestToken) delete s.active
        if (id && s.operations?.[id]) {
          if (!dispatched) delete s.operations[id]
          else s.operations[id].status = 'unknown'
        }
      })
      if (dispatched && writing) throw new TrafficError(`发送结果不确定，已禁止自动重发，请回读核查；操作 ID：${id}`)
      throw e
    }
  }

  // 相同的并发 GET 只发一次
  const inflight = new Map<string, Promise<Response>>()
  return {
    fetch(input, init = {}) {
      const url = new URL(input)
      if (!isBiliApiHost(url) || String(init.method ?? 'GET').toUpperCase() !== 'GET' || init.signal) return guarded(input, init)
      const key = identity(init.headers) + ':' + url.href
      if (!inflight.has(key)) inflight.set(key, guarded(input, init).finally(() => inflight.delete(key)))
      return inflight.get(key)!.then((r) => r.clone())
    },
    state: () => read(),
    status(headers) {
      const s = read()
      const a = s.accounts?.[identity(headers)] ?? {}
      const today = new Date(now()).toLocaleDateString('sv-SE')
      const sameDay = a.date === today
      const sameHour = !!a.hourAt && now() - a.hourAt < 3600000
      const pausedUntil = Number(s.until ?? 0) > now() ? Number(s.until) : null
      return {
        readDay: sameDay ? a.readDay ?? 0 : 0,
        writeDay: sameDay ? a.writeDay ?? 0 : 0,
        readHour: sameHour ? a.readHour ?? 0 : 0,
        writeHour: sameHour ? a.writeHour ?? 0 : 0,
        pausedUntil,
        reason: s.manual?.[identity(headers)] ? '账号需要人工处理登录或验证码' : pausedUntil ? s.reason ?? '平台限制' : null,
      }
    },
    pauseReason(headers) {
      try {
        blocked(read(), identity(headers))
        return null
      } catch (e) {
        return (e as Error).message
      }
    },
    resume: (headers) => locked((s) => { if (s.manual) delete s.manual[identity(headers)] }),
    resolve: (id, outcome) => locked((s) => {
      const op = s.operations?.[id]
      if (!op) throw new TrafficError('找不到操作 ID')
      if (outcome === 'not-sent') delete s.operations![id]
      else op.status = 'confirmed'
    }),
  }
}

const isPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

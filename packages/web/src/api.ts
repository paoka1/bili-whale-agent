// 后端接口封装：同源 cookie 会话；非 GET 自动带 CSRF 头；401 时通知 App 回到登录 / 设置页。
// CSRF 令牌只在登录响应里给一次，存 localStorage 以便刷新后继续用（会话 cookie 本身是 httpOnly）。
const CSRF_KEY = 'whale_csrf'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

let onUnauthorized: (needsSetup: boolean) => void = () => {}
export const setUnauthorizedHandler = (fn: (needsSetup: boolean) => void) => { onUnauthorized = fn }

const csrf = () => { try { return localStorage.getItem(CSRF_KEY) ?? '' } catch { return '' } }
export const saveCsrf = (token: string) => { try { localStorage.setItem(CSRF_KEY, token) } catch { /* 无痕模式下刷新后需重新登录 */ } }

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  // 403 CSRF 失败多半是换了浏览器 / 清了存储，令牌丢了：回登录页重新拿
  if (res.status === 401 || (res.status === 403 && String(data.error).includes('请求校验'))) onUnauthorized(data.needsSetup === true)
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `请求失败（HTTP ${res.status}）`, res.status)
  return data as T
}

/** 通过 http 从别的机器访问时，密码与 cookie 是明文传输 */
export const plainHttpWarning = (loc: { protocol: string; hostname: string }) =>
  loc.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(loc.hostname)

/** 保存时不带 self：它由扫码登录写入，页面里那份可能是扫码前的旧值 */
export const configPayload = (cfg: AppConfig) => ({ ...cfg, self: undefined })

// 只声明网页用到的字段
export type Window = { start: string; end: string; wakes: number }
export type AppConfig = {
  llm: { baseURL: string; model: string; images: boolean }
  vision: { baseURL: string; model: string; enabled: boolean }
  persona: { name: string; ownerTitle: string; selfClaim: string }
  owner: { mid: string; name: string }
  self: { mid: string; name: string }
  preferences: { like: string[]; dislike: string[] }
  risk: Record<'minGapMs' | 'readHourly' | 'readDaily' | 'writeHourly' | 'writeDaily' | 'writeGapSec' | 'dmGapSec', number>
  quota: { shareDaily: number }
  share: { enabled: boolean; via: 'comment' | 'dm'; minScore: number; silentAfterDays: number }
  night: { windows: Window[]; skipChance: number; minGapMin: number; maxVideos: number; maxWakesPerDay?: number | null }
  listen: { comment: boolean; commentIntervalSec: number; dm: boolean }
  notify: { type: 'none' | 'dm' | 'webhook'; url: string }
  dryRun: boolean
  server: { host: string; port: number; tlsCert: string; tlsKey: string }
}
export type ConfigResponse = { config: AppConfig; secrets: { llmApiKey: boolean; visionApiKey: boolean }; persona: string }
export type QrState = { id: string; status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'; image?: string; account?: { mid: string; name: string }; error?: string; expiresAt: number }
export type Account = { loggedIn: boolean; mid: string; name: string }
export type DiaryView = { id: string; date: string | null; title: string; markdown: string }
export type Diaries = { public: string; private: string; memory: string; entries: Record<'public' | 'private', DiaryView[]> }
export type Status = {
  running: string | null; progress: { name: string; ok: boolean }[]; queue: string[]; nextWakeAt: number | null; nextWindow: string | null; lastRunAt: string | null
  dryRun: boolean; serverTime: string; timezone: string
  quota: {
    share: { used: number; configuredDaily: number; enabled: boolean }
    favorites: { used: number; daily: number }
    traffic: { readDay: number; writeDay: number; pausedUntil: number | null; reason: string | null }
  }
}
export type Draft = { id: string; bvid: string; who: string; src: string; message: string; at: string }
export type LogEntry = { at: string; kind: string; target: string | null; note: string }
export type RunRecord = {
  id: string; kind: string; startedAt: string; endedAt: string; status: string; steps: number
  toolCalls: { name: string; ok: boolean }[]; draftsAdded: number; finalText: string; error?: string
}
export type WriteResult ={ status: 'sent' | 'dry-run' | 'refused'; reason?: string; preview?: string }

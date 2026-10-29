// 网页密码独立存储；会话存 sessions.json（只存会话令牌的哈希，0600），重启后不用重新登录。
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'
import { dataPath, writeJsonAtomic } from '@bili-whale/bili'

export type AuthCheck = { ok: true } | { ok: false; retryAfterMs: number }
export interface Auth {
  needsSetup(): boolean
  setupCode(): string
  setup(code: string, password: string): void
  login(password: string, ip: string): { ok: true; session: string; csrf: string } | { ok: false; retryAfterMs: number }
  verify(session: string): boolean
  verifyCsrf(session: string, csrf: string): boolean
  checkPassword(password: string, ip: string): AuthCheck
  changePassword(password: string, session: string): void
  logout(session: string): void
  logoutAll(): void
}

export class AuthError extends Error {}
export const SESSION_SECONDS = 7 * 86_400
const storedAuth = z.strictObject({ salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) })
const passwordHash = (password: string, salt: string) => scryptSync(password, salt, 64, { N: 2 ** 15, maxmem: 64 * 1024 * 1024 })
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
type Session = { csrf: string; expiresAt: number }

export function createAuth(dataDir: string): Auth {
  const file = dataPath(dataDir, 'auth.json')
  let stored: z.infer<typeof storedAuth> | null = null
  try { stored = storedAuth.parse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AuthError('auth.json 无法读取或已损坏，请检查认证文件')
  }
  let code = stored ? '' : String(randomInt(100_000_000)).padStart(8, '0')
  // 监听 0.0.0.0 时，设置前局域网里谁都能猜码；错 10 次就作废，重启后终端会打印新码
  let setupFailures = 0
  const sessionFile = dataPath(dataDir, 'sessions.json')
  // 会话文件坏了就当没有：最多是要重新登录，不影响启动
  const sessions = new Map<string, Session>(Object.entries((() => {
    try { return z.record(z.string(), z.object({ csrf: z.string(), expiresAt: z.number() })).parse(JSON.parse(fs.readFileSync(sessionFile, 'utf8'))) } catch { return {} }
  })()))
  const persist = () => {
    for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key)
    writeJsonAtomic(sessionFile, Object.fromEntries(sessions), 0o600)
  }
  const failures = new Map<string, { count: number; nextAt: number }>()
  function savePassword(password: string): void {
    if (password.length < 10 || password.length > 1024) throw new AuthError('密码需要 10–1024 字')
    const salt = randomBytes(16).toString('hex')
    const next = { salt, hash: passwordHash(password, salt).toString('hex') }
    writeJsonAtomic(file, next, 0o600)
    stored = next
  }
  function sessionOf(token: string): Session | undefined {
    const key = digest(token), session = sessions.get(key)
    if (session && session.expiresAt > Date.now()) return session
    sessions.delete(key)
    return undefined
  }
  function checkPassword(password: string, ip: string): AuthCheck {
    const now = Date.now(), previous = failures.get(ip)
    if (previous && now < previous.nextAt) return { ok: false, retryAfterMs: previous.nextAt - now }
    if (stored && timingSafeEqual(passwordHash(password, stored.salt), Buffer.from(stored.hash, 'hex'))) {
      failures.delete(ip)
      return { ok: true }
    }
    const count = (previous && previous.count < 10 ? previous.count : 0) + 1
    const retryAfterMs = count >= 10 ? 15 * 60_000 : Math.min(2 ** count * 500, 30_000)
    failures.set(ip, { count, nextAt: now + retryAfterMs })
    return { ok: false, retryAfterMs }
  }
  return {
    needsSetup: () => stored === null,
    setupCode: () => code,
    setup(input, password) {
      if (stored) throw new AuthError('网页密码已经设置')
      if (setupFailures >= 10) throw new AuthError('设置码错误次数过多已作废，请重启服务，从终端获取新的设置码')
      if (!equal(input, code)) { setupFailures++; throw new AuthError('设置码错误，请查看启动终端') }
      savePassword(password)
      code = ''
    },
    checkPassword,
    login(password, ip) {
      const result = checkPassword(password, ip)
      if (!result.ok) return result
      const session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex')
      sessions.set(digest(session), { csrf, expiresAt: Date.now() + SESSION_SECONDS * 1000 })
      persist()
      return { ok: true, session, csrf }
    },
    verify: (session) => Boolean(sessionOf(session)),
    verifyCsrf: (session, csrf) => { const value = sessionOf(session); return !!value && equal(value.csrf, csrf) },
    changePassword(password, session) {
      const current = sessionOf(session)
      if (!current) throw new AuthError('会话已失效，请重新登录')
      savePassword(password)
      sessions.clear()
      sessions.set(digest(session), current)
      persist()
    },
    logout: (session) => { sessions.delete(digest(session)); persist() },
    logoutAll: () => { sessions.clear(); persist() },
  }
}

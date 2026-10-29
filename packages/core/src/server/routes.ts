import type { Context, Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import { z } from 'zod'
import {
  approveDraft, biliGet, biliHeaders, dataPath, listDrafts, listFavorites, loadCred, LoginExpiredError,
  readDiaries, readJsonl, readLog, readQuota, rejectDraft,
} from '@bili-whale/bili'
import { loadConfig, readPersona, saveConfig, writePersona } from '../config.js'
import { loadSecrets, maskSecrets, saveSecrets } from '../secrets.js'
import type { RunRecord } from '../runner.js'
import { SESSION_SECONDS } from './auth.js'
import { audit, type AuditEntry } from './audit.js'
import type { AppDeps, ServerEnv } from './app.js'

export const SESSION_COOKIE = 'whale_session'
const password = z.string().max(1024)
const newPassword = password.min(10)
const setupInput = z.strictObject({ code: z.string().max(64), password: newPassword })
const loginInput = z.strictObject({ password })
const configInput = z.strictObject({ config: z.unknown().optional(), persona: z.string().max(3000).optional() })
const secretsInput = z.strictObject({ password, llmApiKey: z.string().max(8192).optional(), visionApiKey: z.string().max(8192).optional() })
const passwordInput = z.strictObject({ current: password, next: newPassword })
const qrInput = z.strictObject({ password: password.optional() })
const rejectInput = z.strictObject({ reason: z.string().max(500).optional() })
const idInput = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/)
const limitInput = z.coerce.number().int().min(0).max(1000)
type Ctx = Context<ServerEnv>
// 只信任实际连接地址，不信任客户端可伪造的转发头。
const ipOf = (c: Ctx): string => { try { return getConnInfo(c).remote.address ?? 'unknown' } catch { return 'unknown' } }

async function body<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  let input: unknown
  try { input = await c.req.json() } catch { throw new InputError() }
  const result = schema.safeParse(input)
  if (!result.success) throw new InputError()
  return result.data
}
export class InputError extends Error {}
function id(c: Ctx): string {
  const result = idInput.safeParse(c.req.param('id'))
  if (!result.success) throw new InputError()
  return result.data
}
function limit(c: Ctx): number {
  const result = limitInput.safeParse(c.req.query('limit') ?? 100)
  if (!result.success) throw new InputError()
  return result.data
}
const cookieOptions = (c: Ctx) => ({ httpOnly: true, sameSite: 'Strict' as const, secure: new URL(c.req.url).protocol === 'https:', path: '/' })

export function registerRoutes(app: Hono<ServerEnv>, deps: AppDeps): void {
  const { dataDir, auth, scheduler, qr, getCtx } = deps
  const record = (c: Ctx, action: AuditEntry['action'], ok = true, target?: string) => audit(dataDir, { action, ip: ipOf(c), ok, ...(target ? { target } : {}) })
  const denied = (c: Ctx, retryAfterMs: number) => {
    c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
    return c.json({ error: '密码错误或尝试过于频繁，请稍后重试', retryAfterMs }, 429)
  }
  const accountChangeBlocked = (c: Ctx) => {
    if (listDrafts(dataDir).length) return c.json({ error: '请先处理全部待审草稿，再更换 B 站账号' }, 409)
    const status = scheduler.status()
    if (status.running || status.queue.length) return c.json({ error: '请等待当前运行与队列完成，再更换 B 站账号' }, 409)
  }
  app.post('/api/setup', async (c) => {
    if (!auth.needsSetup()) return c.json({ error: '网页密码已经设置，请登录' }, 409)
    const input = await body(c, setupInput)
    auth.setup(input.code, input.password)
    record(c, 'setup')
    return c.json({ ok: true })
  })
  app.post('/api/login', async (c) => {
    if (auth.needsSetup()) return c.json({ error: '请先用启动终端的设置码设置密码', needsSetup: true }, 409)
    const input = await body(c, loginInput), result = auth.login(input.password, ipOf(c))
    record(c, 'login', result.ok)
    if (!result.ok) return denied(c, result.retryAfterMs)
    setCookie(c, SESSION_COOKIE, result.session, { ...cookieOptions(c), maxAge: SESSION_SECONDS })
    return c.json({ ok: true, csrf: result.csrf })
  })
  for (const action of ['logout', 'logout-all'] as const) app.post(`/api/${action}`, (c) => {
    if (action === 'logout-all') auth.logoutAll()
    else auth.logout(c.get('session'))
    deleteCookie(c, SESSION_COOKIE, cookieOptions(c))
    record(c, action)
    return c.json({ ok: true })
  })
  app.get('/api/config', (c) => c.json({ config: loadConfig(dataDir), secrets: maskSecrets(loadSecrets(dataDir)), persona: readPersona(dataDir) }))
  app.put('/api/config', async (c) => {
    const input = await body(c, configInput), before = loadConfig(dataDir)
    const config = input.config === undefined ? before : saveConfig(dataDir, input.config)
    if (input.persona !== undefined) writePersona(dataDir, input.persona)
    record(c, 'config')
    return c.json({ ok: true, restartRequired: JSON.stringify(before.server) !== JSON.stringify(config.server) })
  })
  app.put('/api/secrets', async (c) => {
    const { password, ...patch } = await body(c, secretsInput), check = auth.checkPassword(password, ipOf(c))
    if (!check.ok) { record(c, 'secrets', false); return denied(c, check.retryAfterMs) }
    saveSecrets(dataDir, patch)
    record(c, 'secrets')
    return c.json({ ok: true })
  })
  app.put('/api/password', async (c) => {
    const input = await body(c, passwordInput), check = auth.checkPassword(input.current, ipOf(c))
    if (!check.ok) { record(c, 'password', false); return denied(c, check.retryAfterMs) }
    auth.changePassword(input.next, c.get('session'))
    record(c, 'password')
    return c.json({ ok: true })
  })
  app.post('/api/qr/start', async (c) => {
    const input = await body(c, qrInput)
    if (loadCred(dataDir)) {
      const blocked = accountChangeBlocked(c)
      if (blocked) return blocked
      if (input.password === undefined) return c.json({ error: '更换 B 站账号需要输入当前网页密码' }, 400)
      const check = auth.checkPassword(input.password, ipOf(c))
      if (!check.ok) { record(c, 'qr-start', false); return denied(c, check.retryAfterMs) }
    }
    const result = await qr.start()
    record(c, 'qr-start')
    return c.json(result)
  })
  app.get('/api/qr/:id', async (c) => {
    const key = id(c)
    if (loadCred(dataDir)) {
      const blocked = accountChangeBlocked(c)
      if (blocked) { qr.cancel(key); return blocked }
    }
    return c.json(await qr.poll(key))
  })
  app.get('/api/account', async (c) => {
    if (!loadCred(dataDir)) return c.json({ loggedIn: false, mid: '', name: '' })
    try {
      const nav = await biliGet<{ isLogin: boolean; mid: number | string; uname: string }>(getCtx(), 'https://api.bilibili.com/x/web-interface/nav', { noCache: true })
      if (nav.code !== 0 || !nav.data) return c.json({ error: '无法获取 B 站账号状态，请稍后重试' }, 502)
      return c.json({ loggedIn: nav.data.isLogin, mid: nav.data.isLogin ? String(nav.data.mid) : '', name: nav.data.isLogin ? nav.data.uname : '' })
    } catch (error) {
      if (error instanceof LoginExpiredError) return c.json({ loggedIn: false, mid: '', name: '' })
      throw error
    }
  })
  app.get('/api/status', (c) => {
    const config = loadConfig(dataDir), ctx = getCtx(), now = new Date(), date = now.toLocaleDateString('sv-SE')
    const today = (at: string) => new Date(at).toLocaleDateString('sv-SE') === date
    return c.json({ ...scheduler.status(), dryRun: config.dryRun,
      quota: { date,
        share: { used: readQuota(dataDir).filter((row) => row.share && today(row.at)).length, configuredDaily: config.quota.shareDaily, enabled: config.share.enabled },
        favorites: { used: listFavorites(dataDir).filter((row) => today(row.at)).length, daily: 3 },
        traffic: ctx.guard.status(biliHeaders(ctx)),
      }, serverTime: now.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  })
  app.post('/api/wake', (c) => c.json(scheduler.wakeNow()))
  // 验证码等需要人工处理的暂停：主人在 B 站处理完后从网页解除（只清当前账号的人工暂停，定时退避照常到期）
  app.post('/api/traffic/resume', async (c) => {
    const ctx = getCtx()
    await ctx.guard.resume(biliHeaders(ctx))
    record(c, 'traffic-resume')
    return c.json({ ok: true })
  })
  app.get('/api/drafts', (c) => c.json(listDrafts(dataDir)))
  app.post('/api/drafts/:id/approve', async (c) => {
    const key = id(c), result = await approveDraft(getCtx(), key)
    record(c, 'draft-approve', result.status !== 'refused', key)
    return c.json(result, result.status === 'refused' ? 409 : 200)
  })
  app.post('/api/drafts/:id/reject', async (c) => {
    const key = id(c), input = await body(c, rejectInput)
    rejectDraft(dataDir, key, input.reason)
    record(c, 'draft-reject', true, key)
    return c.json({ ok: true })
  })
  app.get('/api/activity', (c) => c.json(readLog(dataDir, limit(c))))
  app.get('/api/runs', (c) => { const n = limit(c); return c.json(n === 0 ? [] : readJsonl<RunRecord>(dataPath(dataDir, 'runs.jsonl'), n)) })
  app.get('/api/diaries', (c) => c.json(readDiaries(dataDir)))
}

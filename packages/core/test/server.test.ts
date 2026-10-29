import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { addDraft, appendJsonl, appendLog, QrLogin, readJsonl, saveCred, writeDiary } from '@bili-whale/bili'
import { draftInput, fakeWrites } from '../../bili/test/write-helpers.js'
import { loadConfig } from '../src/config.js'
import { loadSecrets, saveSecrets } from '../src/secrets.js'
import { createAuth } from '../src/server/auth.js'
import { createApp } from '../src/server/app.js'

const password = '测试密码-12345678'
afterEach(() => vi.useRealTimers())
function setup(initialized = true) {
  const s = fakeWrites(), auth = createAuth(s.dataDir)
  s.ctx.dryRun = true
  if (initialized) auth.setup(auth.setupCode(), password)
  const scheduler = { start: vi.fn(), stop: vi.fn(), wakeNow: vi.fn(() => ({ queued: true })),
    status: () => ({ running: null, queue: [], nextWakeAt: null, nextWindow: null, lastRunAt: null }) }
  const qr = new QrLogin({ save: async () => {} })
  const app = createApp({ dataDir: s.dataDir, auth, scheduler, qr, getCtx: () => ({ ...s.ctx, settings: loadConfig(s.dataDir) }) })
  function login() {
    const result = auth.login(password, 'test')
    if (!result.ok) throw new Error('测试登录失败')
    return { cookie: `whale_session=${result.session}`, 'X-CSRF-Token': result.csrf }
  }
  const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(url, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { ...s, auth, scheduler, qr, app, request, login }
}

it('设置码错 10 次后作废，正确的码也不再接受，需要重启拿新码', async () => {
  const s = setup(false), code = s.auth.setupCode()
  for (let i = 0; i < 10; i++) expect((await s.request('/api/setup', 'POST', { code: 'wrong', password })).status).toBe(400)
  const res = await s.request('/api/setup', 'POST', { code, password })
  expect(res.status).toBe(400)
  expect(await res.text()).toContain('重启')
  expect(s.auth.needsSetup()).toBe(true)
})

it('首次只能设置，设置码错误和短密码被拒，成功后不能重复设置', async () => {
  const s = setup(false)
  expect(s.auth.setupCode()).toMatch(/^\d{8}$/)
  expect((await s.request('/api/config')).status).toBe(401)
  expect((await s.request('/api/login', 'POST', { password })).status).toBe(409)
  expect((await s.request('/api/setup', 'POST', { code: 'wrong', password })).status).toBe(400)
  expect((await s.request('/api/setup', 'POST', { code: s.auth.setupCode(), password: 'short' })).status).toBe(400)
  expect((await s.request('/api/setup', 'POST', { code: s.auth.setupCode(), password })).status).toBe(200)
  expect((await s.request('/api/setup', 'POST', { code: s.auth.setupCode(), password })).status).toBe(409)
  expect(createAuth(s.dataDir).needsSetup()).toBe(false)
  expect(fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8')).not.toContain(password)
  if (process.platform !== 'win32') expect(fs.statSync(path.join(s.dataDir, 'auth.json')).mode & 0o777).toBe(0o600)
})

it('未登录拒绝，登录返回 CSRF 与严格 cookie，缺少或错误 CSRF 的修改被拒', async () => {
  const s = setup()
  expect((await s.request('/api/config')).status).toBe(401)
  const res = await s.request('https://localhost/api/login', 'POST', { password })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')!
  expect(cookie).toMatch(/HttpOnly/)
  expect(cookie).toMatch(/SameSite=Strict/)
  expect(cookie).toMatch(/Secure/)
  expect(cookie).toMatch(/Path=\//)
  const { csrf } = await res.json()
  const headers = { cookie: cookie.split(';')[0]! }
  expect((await s.request('/api/config', 'PUT', { config: { dryRun: false } }, headers)).status).toBe(403)
  expect((await s.request('/api/config', 'PUT', {}, { ...headers, 'X-CSRF-Token': 'wrong' })).status).toBe(403)
  expect((await s.request('/api/config', 'PUT', { config: { dryRun: false } }, { ...headers, 'X-CSRF-Token': csrf })).status).toBe(200)
  expect(readJsonl(path.join(s.dataDir, 'audit.jsonl'))).toContainEqual(expect.objectContaining({ action: 'login', ok: true }))
})

it('配置只回显密钥是否已设置，更新即时保存，人设先校验且监听变化提示重启', async () => {
  const s = setup(), headers = s.login()
  saveSecrets(s.dataDir, { llmApiKey: 'sk-SECRET123', visionApiKey: 'vision-SECRET456' })
  const res = await s.request('/api/config', 'GET', undefined, headers), text = await res.text()
  expect(text).not.toMatch(/sk-SECRET123|vision-SECRET456|SESS-SECRET/)
  expect(JSON.parse(text).secrets).toEqual({ llmApiKey: true, visionApiKey: true })
  const update = await s.request('/api/config', 'PUT', { config: { server: { port: 9000 } }, persona: '喜欢猫咪' }, headers)
  expect(await update.json()).toMatchObject({ restartRequired: true })
  expect((await (await s.request('/api/config', 'GET', undefined, headers)).json()).persona).toBe('喜欢猫咪')
  expect((await s.request('/api/config', 'PUT', { config: { dryRun: false }, persona: '中'.repeat(3001) }, headers)).status).toBe(400)
  expect(loadConfig(s.dataDir).dryRun).toBe(true)
})

it('登录失败按来源退避，连续十次锁十五分钟，成功后恢复', async () => {
  vi.useFakeTimers()
  const s = setup()
  for (let n = 1; n <= 10; n++) {
    const res = await s.request('/api/login', 'POST', { password: 'wrong' })
    expect(res.status).toBe(429)
    const { retryAfterMs } = await res.json()
    expect(retryAfterMs).toBe(n === 10 ? 900_000 : Math.min(2 ** n * 500, 30_000))
    const blocked = await s.request('/api/login', 'POST', { password })
    expect(blocked.status).toBe(429)
    vi.advanceTimersByTime(retryAfterMs)
  }
  expect((await s.request('/api/login', 'POST', { password })).status).toBe(200)
  expect(readJsonl(path.join(s.dataDir, 'audit.jsonl'))).toContainEqual(expect.objectContaining({ action: 'login', ok: false }))
})

it('改密钥需正确密码，重新验密也受登录退避限制', async () => {
  vi.useFakeTimers()
  const s = setup(), headers = s.login()
  expect((await s.request('/api/secrets', 'PUT', { password, llmApiKey: 'new-key' }, headers)).status).toBe(200)
  expect((await s.request('/api/secrets', 'PUT', { password: 'wrong', llmApiKey: 'bad-key' }, headers)).status).toBe(429)
  expect(loadSecrets(s.dataDir).llmApiKey).toBe('new-key')
  vi.advanceTimersByTime(1000)
  expect((await s.request('/api/secrets', 'PUT', { password, visionApiKey: 'vision-key' }, headers)).status).toBe(200)
  expect(loadSecrets(s.dataDir)).toEqual({ llmApiKey: 'new-key', visionApiKey: 'vision-key' })
  const audit = JSON.stringify(readJsonl(path.join(s.dataDir, 'audit.jsonl')))
  expect(audit).not.toMatch(/new-key|vision-key|测试密码/)
  expect(audit).toContain('secrets')
})

it('改密码保留当前会话并撤销其他会话，单独退出与全部退出生效', async () => {
  const s = setup(), current = s.login(), other = s.login()
  expect((await s.request('/api/password', 'PUT', { current: password, next: 'new-password-123' }, current)).status).toBe(200)
  expect((await s.request('/api/config', 'GET', undefined, other)).status).toBe(401)
  expect((await s.request('/api/config', 'GET', undefined, current)).status).toBe(200)
  expect(createAuth(s.dataDir).login('new-password-123', 'test').ok).toBe(true)
  expect((await s.request('/api/logout-all', 'POST', undefined, current)).status).toBe(200)
  expect((await s.request('/api/config', 'GET', undefined, current)).status).toBe(401)
  const res = await s.request('/api/login', 'POST', { password: 'new-password-123' })
  const headers = { cookie: res.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': (await res.json()).csrf }
  expect((await s.request('/api/logout', 'POST', undefined, headers)).status).toBe(200)
  expect((await s.request('/api/config', 'GET', undefined, headers)).status).toBe(401)
})

it('会话七天过期，损坏的认证文件不能当成首次设置', () => {
  vi.useFakeTimers()
  const s = setup(), result = s.auth.login(password, 'test')
  if (!result.ok) throw new Error('登录失败')
  vi.advanceTimersByTime(7 * 86_400_000)
  expect(s.auth.verify(result.session)).toBe(false)
  fs.writeFileSync(path.join(s.dataDir, 'auth.json'), '{broken')
  expect(() => createAuth(s.dataDir)).toThrow('auth.json')
})

it('扫码初次无需验密，已有账号需密码，有待审草稿时拒绝换号', async () => {
  const s = setup(), headers = s.login()
  const start = vi.spyOn(s.qr, 'start').mockResolvedValue({ id: 'qr', status: 'waiting', expiresAt: 123 })
  expect((await s.request('/api/qr/start', 'POST', {}, headers)).status).toBe(200)
  expect(await (await s.request('/api/account', 'GET', undefined, headers)).json()).toEqual({ loggedIn: false, mid: '', name: '' })
  saveCred(s.dataDir, s.ctx.cred)
  expect(await (await s.request('/api/account', 'GET', undefined, headers)).json()).toEqual({ loggedIn: true, mid: '111', name: '小号' })
  expect((await s.request('/api/qr/start', 'POST', {}, headers)).status).toBe(400)
  expect((await s.request('/api/qr/start', 'POST', { password }, headers)).status).toBe(200)
  vi.spyOn(s.qr, 'poll').mockResolvedValue({ id: 'qr', status: 'waiting', expiresAt: 123 })
  expect(await (await s.request('/api/qr/qr', 'GET', undefined, headers)).json()).toMatchObject({ id: 'qr', status: 'waiting' })
  addDraft(s.ctx, { bvid: 'BV1AAAAAAAAA', oid: '101', root: '8', parent: '9', who: '访客', src: '你好', message: '你好呀' })
  expect((await s.request('/api/qr/start', 'POST', { password }, headers)).status).toBe(409)
  expect(start).toHaveBeenCalledTimes(2)
  const poll = vi.mocked(s.qr.poll).mockClear()
  expect((await s.request('/api/qr/qr', 'GET', undefined, headers)).status).toBe(409)
  expect(poll).not.toHaveBeenCalled()
})

it('审批调用现有发送闸门，演练保留草稿且不发写请求，拒绝结果有审计', async () => {
  const s = setup(), headers = s.login(), draft = addDraft(s.ctx, draftInput)
  const approved = await s.request(`/api/drafts/${draft.id}/approve`, 'POST', undefined, headers)
  expect(await approved.json()).toMatchObject({ status: 'dry-run', preview: draft.message })
  expect(s.writes()).toHaveLength(0)
  expect(await (await s.request('/api/drafts', 'GET', undefined, headers)).json()).toHaveLength(1)
  expect((await s.request('/api/drafts/missing/approve', 'POST', undefined, headers)).status).toBe(409)
  const rows = readJsonl(path.join(s.dataDir, 'audit.jsonl'))
  expect(rows).toContainEqual(expect.objectContaining({ action: 'draft-approve', target: draft.id, ok: true }))
  expect(rows).toContainEqual(expect.objectContaining({ action: 'draft-approve', target: 'missing', ok: false }))
})

it('状态包含服务器时间、时区与本地日期用量，唤醒交给调度器排队', async () => {
  const s = setup(), headers = s.login()
  const res = await s.request('/api/status', 'GET', undefined, headers), status = await res.json()
  expect(status).toMatchObject({ dryRun: true, serverTime: expect.any(String), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    quota: { share: { used: 0 }, favorites: { used: 0 }, traffic: { readDay: 0, writeDay: 0 } } })
  expect(Number.isFinite(Date.parse(status.serverTime))).toBe(true)
  expect(await (await s.request('/api/wake', 'POST', undefined, headers)).json()).toEqual({ queued: true })
  expect(s.scheduler.wakeNow).toHaveBeenCalledTimes(1)
})

it('草稿拒绝与活动、运行、两本日记读取接入现有存储，审计不记录输入原文', async () => {
  const s = setup(), headers = s.login()
  const draft = addDraft(s.ctx, { bvid: 'BV1AAAAAAAAA', oid: '101', root: '8', parent: '9', who: '访客', src: '你好', message: '你好呀' })
  expect(await (await s.request('/api/drafts', 'GET', undefined, headers)).json()).toHaveLength(1)
  expect((await s.request(`/api/drafts/${draft.id}/reject`, 'POST', { reason: '私密审核理由' }, headers)).status).toBe(200)
  expect(await (await s.request('/api/drafts', 'GET', undefined, headers)).json()).toEqual([])
  appendLog(s.dataDir, { kind: 'test', note: '活动一', target: null })
  appendLog(s.dataDir, { kind: 'test', note: '活动二', target: null })
  expect(await (await s.request('/api/activity?limit=1', 'GET', undefined, headers)).json()).toMatchObject([{ note: '活动二' }])
  expect((await s.request('/api/activity?limit=invalid', 'GET', undefined, headers)).status).toBe(400)
  expect(await (await s.request('/api/runs?limit=0', 'GET', undefined, headers)).json()).toEqual([])
  appendJsonl(path.join(s.dataDir, 'runs.jsonl'), { id: 'first' })
  appendJsonl(path.join(s.dataDir, 'runs.jsonl'), { id: 'latest' })
  expect(await (await s.request('/api/runs?limit=1', 'GET', undefined, headers)).json()).toEqual([{ id: 'latest' }])
  writeDiary(s.dataDir, 'private', '# 私人日记')
  expect(await (await s.request('/api/diaries', 'GET', undefined, headers)).json()).toEqual({ public: '', private: '# 私人日记' })
  const audit = readJsonl(path.join(s.dataDir, 'audit.jsonl'))
  expect(audit).toContainEqual(expect.objectContaining({ action: 'draft-reject', target: draft.id }))
  expect(JSON.stringify(audit)).not.toContain('私密审核理由')
})

it('错误与参数校验不泄露密钥或 cookie，未知接口返回中文 JSON', async () => {
  const s = setup(), headers = s.login()
  saveSecrets(s.dataDir, { llmApiKey: 'sk-SECRET123' })
  const res = await s.request('/api/config', 'PUT', { config: { llm: { apiKey: 'sk-SECRET123' } } }, headers)
  expect(res.status).toBe(400)
  expect(await res.text()).not.toContain('sk-SECRET123')
  s.scheduler.wakeNow.mockImplementation(() => { throw new Error('SESS-SECRET bili_jct=JCT sk-SECRET123') })
  const error = await s.request('/api/wake', 'POST', undefined, headers)
  expect(error.status).toBe(500)
  expect(await error.text()).not.toMatch(/SESS-SECRET|JCT|sk-SECRET123/)
  const missing = await s.request('/api/missing', 'GET', undefined, headers)
  expect(missing.status).toBe(404)
  expect(missing.headers.get('content-type')).toContain('application/json')
})

it('静态资源和前端页面无需登录，API 不落入前端路由', async () => {
  const s = setup(false), webDist = path.join(s.dataDir, 'web')
  fs.mkdirSync(webDist)
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html>网页</html>')
  const app = createApp({ dataDir: s.dataDir, auth: s.auth, scheduler: s.scheduler, qr: s.qr, getCtx: () => s.ctx, webDist })
  expect(await (await app.request('/activity')).text()).toContain('<html>网页</html>')
  expect((await app.request('/api/config')).status).toBe(401)
  const res = await app.request('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ code: s.auth.setupCode(), password }) })
  expect(res.status).toBe(403)
})

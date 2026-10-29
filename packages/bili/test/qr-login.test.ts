import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { QrLogin } from '../src/qr-login.js'
import { loadCred, saveCred, type BiliCred } from '../src/creds.js'
import { fakeBili, json } from './helpers.js'

const credentials = { sessdata: 'fixture-session-not-real', bili_jct: 'a'.repeat(32), buvid3: '' }
const generated = () => json({ code: 0, data: { url: 'https://passport.bilibili.com/scan?key=fixture', qrcode_key: 'fixture-key' } })
const nav = (over: Record<string, unknown> = {}) => json({ code: 0, data: { isLogin: true, mid: 111, uname: '小号', ...over } })
const success = () => {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.append('set-cookie', `SESSDATA=${credentials.sessdata}; HttpOnly`)
  headers.append('set-cookie', `bili_jct=${credentials.bili_jct}; HttpOnly`)
  return new Response(JSON.stringify({ code: 0, data: { code: 0, url: 'https://example.invalid/secret', refresh_token: 'private-refresh' } }), { headers })
}
type Next = Response | (() => Response | Promise<Response>)
function fixture(responses: Next[], persist?: (cred: BiliCred, account: { mid: string; name: string }) => Promise<void>) {
  let time = 0
  const calls: { url: URL; init: RequestInit }[] = []
  const save = vi.fn(persist ?? (async () => {}))
  const qr = new QrLogin({ save, now: () => time, fetch: async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init })
    const next = responses.shift()
    if (!next) throw new Error('没有测试响应')
    return typeof next === 'function' ? next() : next
  } })
  return { qr, save, calls, advance: (ms = 2000) => { time += ms } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('二维码生成为真实 PNG，返回值不暴露挑战密钥', async () => {
  const qr = new QrLogin({ save: async () => {}, fetch: async () => json({ code: 0, data: { url: 'https://passport.bilibili.com/scan?key=fixture', qrcode_key: 'fixture-key' } }) })
  const state = await qr.start()
  expect(state.status).toBe('waiting')
  expect(Buffer.from(state.image!.split(',')[1]!, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(Buffer.from(state.image!.split(',')[1]!, 'base64').readUInt32BE(16)).toBe(220)
  expect(JSON.stringify(state)).not.toContain('fixture-key')
  qr.cancel()
})

it('等待、已扫码、确认状态节流，验证账号后仅保存一次且返回值脱敏', async () => {
  const f = fixture([generated(), json({ code: 0, data: { code: 86101 } }), json({ code: 0, data: { code: 86090 } }), success(), nav()])
  const start = await f.qr.start()
  expect((await f.qr.poll(start.id)).status).toBe('waiting')
  expect(f.calls).toHaveLength(1)
  f.advance()
  expect((await f.qr.poll(start.id)).status).toBe('waiting')
  await f.qr.poll(start.id)
  expect(f.calls).toHaveLength(2)
  f.advance()
  expect((await f.qr.poll(start.id)).status).toBe('scanned')
  f.advance()
  const result = await f.qr.poll(start.id)
  expect(result).toMatchObject({ status: 'confirmed', account: { mid: '111', name: '小号' } })
  expect(result.image).toBeUndefined()
  expect(f.save).toHaveBeenCalledExactlyOnceWith(credentials, { mid: '111', name: '小号' })
  expect(JSON.stringify(result)).not.toMatch(/fixture-session|aaaa|private-refresh|example.invalid|fixture-key|SESSDATA/)
  expect((await f.qr.poll(start.id)).status).toBe('confirmed')
  expect(f.save).toHaveBeenCalledTimes(1)
  expect(f.calls.every((c) => c.init.redirect === 'error' && c.init.signal instanceof AbortSignal)).toBe(true)
  expect(new Headers(f.calls.at(-1)!.init.headers).get('cookie')).toContain(credentials.sessdata)
  expect(new Headers(f.calls[0]!.init.headers).get('cookie')).toBeNull()
})

it('到期和远端过期都清除二维码，不保存凭据', async () => {
  const local = fixture([generated()])
  const a = await local.qr.start()
  local.advance(180000)
  expect(await local.qr.poll(a.id)).toMatchObject({ status: 'expired' })
  expect((await local.qr.poll(a.id)).image).toBeUndefined()
  expect(local.calls).toHaveLength(1)
  const remote = fixture([generated(), json({ code: 0, data: { code: 86038 } })])
  const b = await remote.qr.start()
  remote.advance()
  expect((await remote.qr.poll(b.id)).status).toBe('expired')
  expect(remote.save).not.toHaveBeenCalled()
})

it('取消及新挑战使旧 ID 失效，无法保存凭据', async () => {
  const f = fixture([generated(), generated()])
  const old = await f.qr.start()
  f.qr.cancel('不匹配的 ID')
  expect((await f.qr.poll(old.id)).status).toBe('waiting')
  f.qr.cancel(old.id)
  expect(await f.qr.poll(old.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('取消') })
  f.advance()
  const current = await f.qr.start()
  expect(current.id).not.toBe(old.id)
  await expect(f.qr.poll(old.id)).rejects.toThrow(/失效/)
  expect(f.save).not.toHaveBeenCalled()
  f.qr.cancel()
})

it('频繁生成二维码在网络请求前就被节流', async () => {
  const f = fixture([generated()])
  await f.qr.start()
  await expect(f.qr.start()).rejects.toThrow(/两秒/)
  expect(f.calls).toHaveLength(1)
  f.qr.cancel()
})

it('并发轮询共用一个请求，不重复保存', async () => {
  const pending = deferred<Response>()
  const f = fixture([generated(), () => pending.promise, nav()])
  const state = await f.qr.start()
  f.advance()
  const a = f.qr.poll(state.id), b = f.qr.poll(state.id)
  pending.resolve(success())
  expect(await a).toEqual(await b)
  expect(f.calls).toHaveLength(3)
  expect(f.save).toHaveBeenCalledTimes(1)
})

it('取消后迟到的成功轮询不能保存凭据', async () => {
  const pending = deferred<Response>()
  const f = fixture([generated(), () => pending.promise])
  const state = await f.qr.start()
  f.advance()
  const polled = f.qr.poll(state.id)
  f.qr.cancel()
  pending.resolve(success())
  expect((await polled).status).toBe('failed')
  expect(f.save).not.toHaveBeenCalled()
  expect(f.calls).toHaveLength(2)
})

it('验证账号期间取消也不能覆盖旧凭据', async () => {
  const pending = deferred<Response>(), entered = deferred<void>()
  const f = fixture([generated(), success(), () => { entered.resolve(); return pending.promise }])
  const state = await f.qr.start()
  f.advance()
  const polled = f.qr.poll(state.id)
  await entered.promise
  f.qr.cancel()
  pending.resolve(nav())
  expect((await polled).status).toBe('failed')
  expect(f.save).not.toHaveBeenCalled()
})

it('旧二维码生成响应迟到，不会替换新挑战', async () => {
  const pending = deferred<Response>()
  const f = fixture([() => pending.promise, generated()])
  const old = f.qr.start()
  const rejected = expect(old).rejects.toThrow(/失效|取消/)
  f.advance()
  const next = await f.qr.start()
  pending.resolve(generated())
  await rejected
  expect((await f.qr.poll(next.id)).status).toBe('waiting')
  f.qr.cancel()
})

it('验证账号失败不调用保存，原凭据文件保持不变', async () => {
  const { dataDir } = fakeBili(() => undefined)
  const old = { sessdata: 'old-existing-session-secret', bili_jct: 'b'.repeat(32) }
  saveCred(dataDir, old)
  const before = fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8')
  const f = fixture([generated(), success(), nav({ isLogin: false })], async (cred) => { saveCred(dataDir, cred) })
  const state = await f.qr.start()
  f.advance()
  expect((await f.qr.poll(state.id)).status).toBe('failed')
  expect(f.save).not.toHaveBeenCalled()
  expect(fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8')).toBe(before)
})

it('确认成功后用现有原子凭据存储保存，状态不回显凭据', async () => {
  const { dataDir } = fakeBili(() => undefined)
  const f = fixture([generated(), success(), nav()], async (cred) => { saveCred(dataDir, cred) })
  const state = await f.qr.start()
  f.advance()
  expect((await f.qr.poll(state.id)).status).toBe('confirmed')
  expect(loadCred(dataDir)).toEqual(credentials)
  if (process.platform !== 'win32') expect(fs.statSync(path.join(dataDir, 'credentials.json')).mode & 0o777).toBe(0o600)
})

it.each([{ mid: 0 }, { mid: 'bad' }, { isLogin: false }, { mid: [111] }])('拒绝无效 nav 身份 %j', async (over) => {
  const f = fixture([generated(), success(), nav(over)])
  const state = await f.qr.start()
  f.advance()
  expect((await f.qr.poll(state.id)).status).toBe('failed')
  expect(f.save).not.toHaveBeenCalled()
})

it('账号昵称里的凭据、挑战 key 和刷新 token 脱敏', async () => {
  const f = fixture([generated(), success(), nav({ uname: `${credentials.sessdata} ${credentials.bili_jct} fixture-key private-refresh` })])
  const state = await f.qr.start()
  f.advance()
  const result = await f.qr.poll(state.id)
  expect(result.status).toBe('confirmed')
  expect(JSON.stringify(result)).not.toMatch(/fixture-session|aaaa|fixture-key|private-refresh/)
})

it('长凭据先脱敏再截断昵称，不能泄露凭据前缀', async () => {
  const secret = 'fixture-long-private-session-' + 'x'.repeat(300)
  const response = success()
  response.headers.set('set-cookie', `SESSDATA=${secret}; HttpOnly`)
  response.headers.append('set-cookie', `bili_jct=${credentials.bili_jct}; HttpOnly`)
  const f = fixture([generated(), response, nav({ uname: secret })])
  const state = await f.qr.start()
  f.advance()
  expect((await f.qr.poll(state.id)).account?.name).toBe('已打码')
})

it('科学计数法产生的不安全数字账号不能当作精确 ID', async () => {
  const f = fixture([generated(), success(), new Response('{"code":0,"data":{"isLogin":true,"mid":9.007199254740993e15}}')])
  const state = await f.qr.start()
  f.advance()
  expect((await f.qr.poll(state.id)).status).toBe('failed')
  expect(f.save).not.toHaveBeenCalled()
})

it('本地保存失败不伪报确认，也不把异常中的凭据回传', async () => {
  const f = fixture([generated(), success(), nav()], async () => { throw new Error(credentials.sessdata) })
  const state = await f.qr.start()
  f.advance()
  const result = await f.qr.poll(state.id)
  expect(result.status).toBe('failed')
  expect(JSON.stringify(result)).not.toContain(credentials.sessdata)
})

it('已进入原子保存时等待其完成，拒绝生成新挑战', async () => {
  const saved = deferred<void>(), entered = deferred<void>()
  const f = fixture([generated(), success(), nav()], async () => { entered.resolve(); await saved.promise })
  const state = await f.qr.start()
  f.advance()
  const polled = f.qr.poll(state.id)
  await entered.promise
  f.advance()
  f.qr.cancel()
  await expect(f.qr.start()).rejects.toThrow(/正在保存/)
  saved.resolve()
  expect((await polled).status).toBe('confirmed')
  expect(f.save).toHaveBeenCalledTimes(1)
})

it.each(['https://evil.invalid/scan', 'http://passport.bilibili.com/scan', 'https://user@passport.bilibili.com/scan'])('拒绝非法二维码来源 %s', async (url) => {
  const f = fixture([json({ code: 0, data: { url, qrcode_key: 'fixture-key' } })])
  await expect(f.qr.start()).rejects.toThrow(/二维码/)
  expect(f.save).not.toHaveBeenCalled()
})

it.each([
  () => json({ code: 0, data: { code: 999, message: credentials.sessdata } }),
  () => json({ code: 0, data: { code: 0 } }),
  () => new Response(credentials.sessdata, { status: 500 }),
  () => new Response('<html>' + credentials.sessdata),
])('未知状态、缺凭据或坏响应均不保存、不泄露上游正文', async (response) => {
  const f = fixture([generated(), response()])
  const state = await f.qr.start()
  f.advance()
  const result = await f.qr.poll(state.id)
  expect(result.status).toBe('failed')
  expect(JSON.stringify(result)).not.toContain(credentials.sessdata)
  expect(f.save).not.toHaveBeenCalled()
})

it('网络错误和超过 128KB 的登录响应使用固定错误信息', async () => {
  const network = fixture([() => { throw new Error(credentials.sessdata) }])
  await expect(network.qr.start()).rejects.not.toThrow(credentials.sessdata)
  const large = fixture([new Response('a'.repeat(128 * 1024 + 1))])
  await expect(large.qr.start()).rejects.toThrow(/请求失败/)
  expect(large.save).not.toHaveBeenCalled()
})

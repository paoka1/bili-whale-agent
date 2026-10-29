import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { biliGet, biliPost, DryRunError, LoginExpiredError, signWbi } from '../src/api.js'
import { createTrafficGuard, RISK_DEFAULTS, TrafficError } from '../src/traffic.js'
import { defaultSettings, type BiliContext } from '../src/context.js'

const keys = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' }
const navOk = { code: 0, data: { isLogin: true, wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${keys.imgKey}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${keys.subKey}.png` } } }
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

type Call = { url: URL; init: RequestInit }
function makeCtx(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, over: Partial<BiliContext> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-api-'))
  dirs.push(dataDir)
  const calls: Call[] = []
  let time = Date.now()
  const guard = createTrafficGuard({
    dataDir,
    settings: () => RISK_DEFAULTS,
    now: () => time,
    sleep: async (ms) => { time += ms },
    transport: async (input, init = {}) => { const url = new URL(String(input)); calls.push({ url, init }); return handler(url, init) },
  })
  const ctx: BiliContext = {
    dataDir,
    cred: { sessdata: 'SESS-SECRET', bili_jct: 'JCT', buvid3: '' },
    guard,
    settings: defaultSettings(),
    dryRun: false,
    now: () => time,
    ...over,
  }
  return { ctx, calls }
}

it('WBI 签名与已知向量一致', () => {
  expect(signWbi({ foo: '114', bar: '514', baz: 1919810 }, keys, 1702204169000)).toBe('bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee')
  expect(() => signWbi({}, { imgKey: '', subKey: '' })).toThrow(/密钥/)
})

it('view 自动改走签名接口，并缓存元信息', async () => {
  const { ctx, calls } = makeCtx((url) => url.pathname.endsWith('/nav') ? json(navOk) : json({ code: 0, data: { aid: 42 } }))
  const r = await biliGet<{ aid: number }>(ctx, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890')
  expect(r.data?.aid).toBe(42)
  const view = calls.find((c) => c.url.pathname.includes('view'))!
  expect(view.url.pathname).toBe('/x/web-interface/wbi/view')
  expect(view.url.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/)
  const again = await biliGet<{ aid: number }>(ctx, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890')
  expect(again.cached).toBe(true)
  expect(calls.filter((c) => c.url.pathname.includes('view'))).toHaveLength(1)
})

it('请求带上 cookie，非 B 站地址被拒且不发请求', async () => {
  const { ctx, calls } = makeCtx(() => json({ code: 0, data: {} }))
  await biliGet(ctx, 'https://api.bilibili.com/x/v2/reply?oid=1&type=1')
  expect(new Headers(calls[0]!.init.headers).get('cookie')).toContain('SESSDATA=SESS-SECRET')
  await expect(biliGet(ctx, 'https://example.com/x')).rejects.toThrow(/不允许/)
  expect(calls).toHaveLength(1)
})

it('HTML、非 JSON 与网络错误返回可读信息，不泄露正文或凭据', async () => {
  for (const make of [() => new Response('<html>secret</html>', { status: 412 }), () => new Response('<html>secret</html>'), () => new Response('null')]) {
    const { ctx } = makeCtx(make)
    const r = await biliGet(ctx, 'https://api.bilibili.com/x/v2/reply?oid=1')
    expect(r.code).not.toBe(0)
    expect(r.message).toMatch(/HTTP/)
    expect(r.message).not.toMatch(/secret|SyntaxError/)
  }
  const { ctx } = makeCtx(() => { throw new Error('boom SESS-SECRET') })
  const r = await biliGet(ctx, 'https://api.bilibili.com/x/v2/reply?oid=1')
  expect(r.message).not.toMatch(/SESS-SECRET/)
})

it('暂停中：可缓存的元信息返回旧缓存，其他请求抛 TrafficError', async () => {
  let paused = false
  const { ctx } = makeCtx((url) => {
    if (paused) return new Response('', { status: 429, headers: { 'retry-after': '600' } })
    return url.pathname.endsWith('/nav') ? json(navOk) : json({ code: 0, data: { aid: 7 } })
  })
  await biliGet(ctx, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890')
  paused = true
  await biliGet(ctx, 'https://api.bilibili.com/x/v2/reply?oid=1')
  const stale = await biliGet<{ aid: number }>(ctx, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890', { noCache: false, ttlMs: 0 })
  expect(stale.data?.aid).toBe(7)
  expect(stale.cached).toBe(true)
  await expect(biliGet(ctx, 'https://api.bilibili.com/x/v2/reply?oid=2')).rejects.toBeInstanceOf(TrafficError)
})

it('登录失效（-101）抛 LoginExpiredError', async () => {
  const { ctx } = makeCtx(() => json({ code: -101, message: '账号未登录' }))
  await expect(biliGet(ctx, 'https://api.bilibili.com/x/v2/reply?oid=1')).rejects.toBeInstanceOf(LoginExpiredError)
})

it('写请求的 csrf 放在 body，不在 URL', async () => {
  const { ctx, calls } = makeCtx(() => json({ code: 0, data: { rpid: 1 } }))
  await biliPost(ctx, 'https://api.bilibili.com/x/v2/reply/add', { oid: '1', type: '1', message: 'hi' })
  const c = calls[0]!
  expect(c.url.href).not.toContain('csrf')
  expect(c.init.method).toBe('POST')
  expect(new URLSearchParams(String(c.init.body)).get('csrf')).toBe('JCT')
})

it('演练模式下 biliPost 直接拒绝，不发请求', async () => {
  const { ctx, calls } = makeCtx(() => json({ code: 0 }), { dryRun: true })
  await expect(biliPost(ctx, 'https://api.bilibili.com/x/v2/reply/add', { message: 'hi' })).rejects.toBeInstanceOf(DryRunError)
  expect(calls).toHaveLength(0)
})

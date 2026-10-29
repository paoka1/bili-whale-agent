// B 站接口客户端：WBI 签名、元信息缓存、统一的错误形状。移植自 upstream/tools/lib/bili-api.mjs。
// 风控暂停与退避由 traffic.ts 统一负责，这里不再另设一套熔断。
import crypto from 'node:crypto'
import type { BiliContext } from './context.js'
import { cookieHeader } from './creds.js'
import { assertBiliUrl, isBiliApiHost } from './net.js'
import { dataPath } from './paths.js'
import { readJson, writeJsonAtomic } from './store.js'
import { TrafficError } from './traffic.js'

export type BiliResponse<T> = { code: number; message: string; data?: T; cached?: boolean }

export class LoginExpiredError extends Error {
  constructor() {
    super('B 站登录已失效，请在网页上重新扫码登录')
    this.name = 'LoginExpiredError'
  }
}

export class DryRunError extends Error {
  constructor() {
    super('演练模式下不允许真实写入')
    this.name = 'DryRunError'
  }
}

/** 风控暂停与登录失效要一路抛到调度器；其他失败可以降级（少一路素材、跳过一个词） */
export const isFatalBiliError = (e: unknown): boolean => e instanceof TrafficError || e instanceof LoginExpiredError

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

export function signWbi(params: Record<string, string | number>, keys: { imgKey: string; subKey: string }, now = Date.now()): string {
  const raw = keys.imgKey + keys.subKey
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map((i) => raw[i]).join('').slice(0, 32)
  const values: Record<string, string | number> = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

const keyOf = (u: string) => u.split('/').at(-1)!.split('.')[0]!
export const wbiKeysFromNav = (img: { img_url: string; sub_url: string }) => ({ imgKey: keyOf(img.img_url), subKey: keyOf(img.sub_url) })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const CACHE_TTL_MS = 24 * 3600 * 1000
const NAV_TTL_MS = 10 * 60 * 1000 // WBI 密钥会轮换
const STALE_MAX_MS = 7 * CACHE_TTL_MS
// 只缓存静态元信息；评论、收件箱、播放地址（含短期授权）一律实时获取
const CACHEABLE = [/^\/x\/web-interface\/(wbi\/)?view$/, /^\/x\/space\/wbi\/acc\/info$/, /^\/x\/tag\/archive\/tags$/]
const SIGNED_PATHS: Record<string, string> = {
  '/x/web-interface/view': '/x/web-interface/wbi/view',
  '/x/player/playurl': '/x/player/wbi/playurl',
}

type CacheEntry = { at: number; data: BiliResponse<unknown> }
const cacheFile = (ctx: BiliContext) => dataPath(ctx.dataDir, 'api-cache.json')
const isNav = (u: URL) => u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
const isCacheable = (u: URL) => u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))

// 缓存键：去掉每次都变的签名参数并排序；按账号区分
function cacheKey(ctx: BiliContext, u: URL): string {
  const path = SIGNED_PATHS[u.pathname] ?? u.pathname
  const params = [...u.searchParams.entries()].filter(([k]) => k !== 'wts' && k !== 'w_rid').sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  const account = crypto.createHash('sha256').update(ctx.cred.sessdata).digest('hex').slice(0, 16)
  return `${account}:${u.hostname}${path}?${new URLSearchParams(params)}`
}

export function biliHeaders(ctx: BiliContext): Record<string, string> {
  return { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader(ctx.cred) }
}

/** B 站回复和私信的整数 ID 可超出安全范围；JSON 字符串里的数字保持原样。 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
    return /^-?(?:0|[1-9]\d*)$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token
  }))
}

async function parse<T>(response: Response): Promise<BiliResponse<T>> {
  if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B 站风控或接口异常，请稍后重试）` }
  const text = await response.text()
  try {
    // 2026-10-22 上游修复：评论/私信 ID 可能超出安全整数范围，必须保留十进制原值。
    const data = parseJsonExact(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid')
    const body = data as Record<string, unknown>
    return { ...body, code: Number(body.code), message: String(body.message ?? '') } as BiliResponse<T>
  } catch {
    return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更` }
  }
}

function networkFailure(error: unknown): BiliResponse<never> {
  if (error instanceof TrafficError) throw error
  return { code: -1, message: (error as Error)?.name === 'TimeoutError' ? '请求超时（30 秒）' : '请求失败（网络异常）' }
}

export type GetOptions = { wbi?: boolean; ttlMs?: number; noCache?: boolean }

/** GET 一个 B 站接口。风控暂停时抛 TrafficError（可缓存的元信息返回旧缓存），登录失效抛 LoginExpiredError。 */
export async function biliGet<T>(ctx: BiliContext, input: string, opt: GetOptions = {}): Promise<BiliResponse<T>> {
  const url = assertBiliUrl(input)
  const canCache = !opt.noCache && (isCacheable(url) || isNav(url))
  const key = cacheKey(ctx, url)
  const store = () => readJson<Record<string, CacheEntry>>(cacheFile(ctx), {})

  if (canCache) {
    const hit = store()[key]
    const ttl = isNav(url) ? NAV_TTL_MS : opt.ttlMs ?? CACHE_TTL_MS
    if (hit && ctx.now() - hit.at < ttl) return { ...(hit.data as BiliResponse<T>), cached: true }
  }
  const stale = (): BiliResponse<T> | null => {
    if (opt.noCache || !isCacheable(url)) return null
    const hit = store()[key]
    return hit?.data.code === 0 && ctx.now() - hit.at < STALE_MAX_MS ? { ...(hit.data as BiliResponse<T>), cached: true } : null
  }

  let result: BiliResponse<T>
  try {
    const signedPath = url.hostname === 'api.bilibili.com' ? SIGNED_PATHS[url.pathname] : undefined
    if (signedPath || opt.wbi) {
      const nav = await biliGet<{ wbi_img?: { img_url: string; sub_url: string } }>(ctx, 'https://api.bilibili.com/x/web-interface/nav', { noCache: opt.noCache })
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      if (signedPath) url.pathname = signedPath
      url.search = signWbi(Object.fromEntries(url.searchParams), wbiKeysFromNav(nav.data.wbi_img), ctx.now())
    }
    result = await parse<T>(await ctx.guard.fetch(url, { headers: biliHeaders(ctx) }))
  } catch (e) {
    if (e instanceof TrafficError) {
      const old = stale()
      if (old) return old
    }
    return networkFailure(e)
  }

  // nav 用 -101 表示「未登录」，这是正常查询结果，不当作登录失效
  if (result.code === -101 && !isNav(url)) throw new LoginExpiredError()
  if (result.code === 0 && canCache) {
    const all = store()
    all[key] = { at: ctx.now(), data: result }
    const keys = Object.keys(all)
    if (keys.length > 400) {
      keys.sort((a, b) => all[a]!.at - all[b]!.at)
      for (const k of keys.slice(0, keys.length - 400)) delete all[k]
    }
    writeJsonAtomic(cacheFile(ctx), all)
  }
  return result
}

/**
 * 取原始资源（字幕 JSON、弹幕 XML 这类不是 `{ code, data }` 形状的）。
 * cookie 只发给 *.bilibili.com，CDN（hdslb 等）不带。取不到返回 null；风控暂停照常抛 TrafficError。
 */
export async function biliFetchRaw(ctx: BiliContext, input: string): Promise<Buffer | null> {
  const url = assertBiliUrl(input)
  const { cookie, ...headers } = biliHeaders(ctx)
  try {
    const response = await ctx.guard.fetch(url, { headers: isBiliApiHost(url) ? { ...headers, cookie } : headers })
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null
  } catch (e) {
    if (e instanceof TrafficError) throw e
    return null
  }
}

/** POST 表单到 B 站。csrf 自动放进 body；演练模式下直接拒绝（写类函数应先自行处理演练，这里是第二道保险）。 */
export async function biliPost<T>(ctx: BiliContext, input: string, form: Record<string, string>, opt: { waitWriteMs?: number } = {}): Promise<BiliResponse<T>> {
  if (ctx.dryRun) throw new DryRunError()
  const url = assertBiliUrl(input)
  const body = new URLSearchParams({ ...form, csrf: form.csrf ?? ctx.cred.bili_jct })
  let result: BiliResponse<T>
  try {
    const response = await ctx.guard.fetch(url, {
      method: 'POST',
      headers: { ...biliHeaders(ctx), 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      waitWriteMs: opt.waitWriteMs,
    })
    result = await parse<T>(response)
  } catch (e) {
    return networkFailure(e)
  }
  if (result.code === -101) throw new LoginExpiredError()
  return result
}

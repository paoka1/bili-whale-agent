// 读类能力测试共用：一个按 URL 路由的假 B 站，外加记录下来的请求。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { createTrafficGuard, RISK_DEFAULTS } from '../src/traffic.js'
import { defaultSettings, type BiliContext } from '../src/context.js'

export const keys = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' }
export const navOk = { code: 0, data: { isLogin: true, wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${keys.imgKey}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${keys.subKey}.png` } } }
export const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } })

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await fs.promises.rm(d, { recursive: true, force: true }) })

export type Call = { url: URL; init: RequestInit }
/** handler 返回 undefined 时：nav 回固定密钥，其余回 404 */
export function fakeBili(handler: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined, over: Partial<BiliContext> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-read-'))
  dirs.push(dataDir)
  const calls: Call[] = []
  let time = Date.now()
  const guard = createTrafficGuard({
    dataDir,
    settings: () => RISK_DEFAULTS,
    now: () => time,
    sleep: async (ms) => { time += ms },
    transport: async (input, init = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      const r = await handler(url, init)
      if (r) return r
      return url.pathname.endsWith('/nav') ? json(navOk) : new Response('not found', { status: 404 })
    },
  })
  const ctx: BiliContext = {
    dataDir,
    cred: { sessdata: 'SESS-SECRET', bili_jct: 'JCT', buvid3: '' },
    guard,
    settings: defaultSettings(),
    dryRun: true,
    now: () => time,
    ...over,
  }
  return { ctx, calls, dataDir }
}

export const viewData = (over: Record<string, unknown> = {}) => ({
  bvid: 'BV1AAAAAAAAA', aid: 101, cid: 202, title: '测试视频', desc: '简介', pic: 'http://i0.hdslb.com/bfs/archive/c.jpg', duration: 125, pubdate: 1761700000,
  owner: { mid: 9, name: 'UP主' }, stat: { view: 1000, danmaku: 50, like: 30, favorite: 20, reply: 10 },
  ...over,
})

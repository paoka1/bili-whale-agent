// 启动命令：把配置、B 站上下文、agent、调度器、网页接口接在一起。bin.ts 只负责调用 main。
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createTrafficGuard, loadCred, QrLogin, resolveDataDir, saveCred, type BiliContext } from '@bili-whale/bili'
import { loadConfig, readPersona, saveConfig, writePersona } from './config.js'
import { runAgent } from './runner.js'
import { createScheduler } from './scheduler.js'
import { loadSecrets } from './secrets.js'
import { createApp } from './server/app.js'
import { createAuth } from './server/auth.js'

export type CliOptions = { command: 'start'; host?: string; port?: number; data?: string }

export function parseCliArgs(argv: string[]): CliOptions {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: { host: { type: 'string' }, port: { type: 'string' }, data: { type: 'string' } },
  })
  if (positionals.length !== 1 || positionals[0] !== 'start') throw new Error('用法：bili-whale start [--host <地址>] [--port <端口>] [--data <数据目录>]')
  const port = values.port === undefined ? undefined : Number(values.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error(`端口必须是 1–65535 的整数：${values.port}`)
  return { command: 'start', ...(values.host ? { host: values.host } : {}), ...(port ? { port } : {}), ...(values.data ? { data: values.data } : {}) }
}

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const PERSONA_TEMPLATE = fileURLToPath(new URL('../assets/persona.template.md', import.meta.url))
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1']

/** 启动网页与调度器。host / port 不传时用配置里的值（命令行参数只影响本次运行，不写回配置）。 */
export async function startService(opt: { dataDir: string; host?: string; port?: number; log?: (line: string) => void }): Promise<{ url: string; stop(): Promise<void> }> {
  const { dataDir } = opt
  const log = opt.log ?? ((line: string) => console.log(line))
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const cfg = loadConfig(dataDir) // 配置损坏就在启动时报错，不带病运行
  if (!readPersona(dataDir) && fs.existsSync(PERSONA_TEMPLATE)) writePersona(dataDir, fs.readFileSync(PERSONA_TEMPLATE, 'utf8'))

  const guard = createTrafficGuard({ dataDir, settings: () => loadConfig(dataDir).risk })
  const getCtx = (): BiliContext => {
    const config = loadConfig(dataDir)
    return { dataDir, cred: loadCred(dataDir) ?? { sessdata: '', bili_jct: '' }, guard, settings: config, dryRun: config.dryRun, now: Date.now }
  }
  const shutdown = new AbortController()
  const scheduler = createScheduler({
    dataDir, getConfig: () => loadConfig(dataDir), getCtx,
    run: (kind, prompt, onToolCall) => runAgent({ kind, prompt }, { ctx: getCtx(), cfg: loadConfig(dataDir), secrets: loadSecrets(dataDir), signal: shutdown.signal, onToolCall }),
  })
  // 扫码成功：保存凭据，并把登录的账号记为「她自己」，写操作会核对当前登录的就是这个号
  const qr = new QrLogin({ save: async (cred, account) => { saveCred(dataDir, cred); saveConfig(dataDir, { self: account }) } })
  const auth = createAuth(dataDir)
  const webDist = fs.existsSync(WEB_DIST) ? WEB_DIST : undefined
  if (!webDist) log('⚠ 网页还没构建（packages/web/dist 不存在），先在仓库根目录运行 npm run build')
  const app = createApp({ dataDir, auth, scheduler, getCtx, qr, webDist })

  const host = opt.host ?? cfg.server.host
  const tls = cfg.server.tlsCert && cfg.server.tlsKey
    ? { cert: fs.readFileSync(cfg.server.tlsCert), key: fs.readFileSync(cfg.server.tlsKey) } : null
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: host, port: opt.port ?? cfg.server.port, ...(tls ? { createServer: https.createServer, serverOptions: tls } : {}) }, () => resolve(s))
    s.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  const anyHost = host === '0.0.0.0' || host === '::'
  const origin = (h: string) => `${tls ? 'https' : 'http'}://${h.includes(':') ? `[${h}]` : h}:${port}`
  const url = origin(anyHost ? '127.0.0.1' : host)
  log(`bili-whale 已启动：${anyHost ? `${origin('<本机 IP>')}（本机可用 ${url}）` : url}　数据目录：${dataDir}`)
  if (!tls && !LOCAL_HOSTS.includes(host)) log('⚠ 正在监听非本机地址且没有配置 HTTPS：网页密码与登录状态在网络上是明文传输，只在可信网络里使用')
  if (auth.needsSetup()) log(`首次使用：在网页上输入设置码 ${auth.setupCode()} 并设置密码（设置码错 10 次会作废，重启后换新码）`)
  log(`服务器时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}（作息按这个时区计算）`)
  scheduler.start()

  return {
    url,
    async stop() {
      scheduler.stop()
      // 等当前这一轮跑完，最多 30 秒，之后中止
      const deadline = Date.now() + 30_000
      while (scheduler.status().running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
      shutdown.abort()
      if ('closeAllConnections' in server) server.closeAllConnections() // 断开浏览器的长连接，否则 close 会一直等
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let opt: CliOptions
  try { opt = parseCliArgs(argv) } catch (e) { console.error((e as Error).message); process.exit(2) }
  const service = await startService({ dataDir: resolveDataDir({ dir: opt.data }), host: opt.host, port: opt.port })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    console.log('正在退出（等待当前运行结束，最多 30 秒）…')
    await service.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

#!/usr/bin/env node
// 用无头 Chrome / Edge 按 2 倍像素密度截 README 用的两张图（PNG）：活动页、日记页（月历选中最近一天）。
// 只对本机用演示数据起的临时实例操作，见 CLAUDE.md「看网页效果」。不需要额外依赖（用 Node 自带的 WebSocket 走 DevTools 协议）。
// 用法：node scripts/screenshot.mjs --url http://127.0.0.1:8791 --code <终端打印的设置码> [--out docs/images] [--browser <chrome 路径>]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { url: { type: 'string' }, code: { type: 'string' }, out: { type: 'string', default: 'docs/images' }, browser: { type: 'string' } } })
if (!values.url || !values.code) {
  console.error('用法：node scripts/screenshot.mjs --url http://127.0.0.1:8791 --code <设置码> [--out docs/images] [--browser <chrome 路径>]')
  process.exit(2)
}
const base = values.url.replace(/\/$/, '')
const browser = values.browser ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p))
if (!browser) throw new Error('找不到 Chrome / Edge，请用 --browser 指定')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 新实例：用设置码设一个随机密码并登录，拿到会话 cookie
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const password = 'demo-' + crypto.randomUUID()
const setup = await post('/api/setup', { code: values.code, password })
const login = await post('/api/login', { password })
if (!setup.ok || !login.ok) throw new Error(`设置或登录失败（${setup.status} / ${login.status}）：需要刚启动、还没设过密码的实例和它打印的设置码`)
const [cookieName, cookieValue] = login.headers.get('set-cookie').split(';')[0].split('=')

// 固定复用一个临时浏览器配置目录：每次重新设会话 cookie，不会越积越多，也不必删（Windows 上浏览器子进程退出慢，删不干净）
const profile = path.join(os.tmpdir(), 'bili-whale-screenshot-profile')
const started = Date.now() - 1000
const chrome = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
try {
  let port
  // 上次运行留下的端口文件作废，等这次的浏览器写出新的
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !port; i++) {
    try { if (fs.statSync(portFile).mtimeMs >= started) port = fs.readFileSync(portFile, 'utf8').split('\n')[0] } catch { /* 还没写出来 */ }
    if (!port) await sleep(100)
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, (msg) => msg.error ? reject(new Error(`${method}：${msg.error.message}`)) : resolve(msg.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
  const shot = async (name, clip) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } })
    fs.mkdirSync(values.out, { recursive: true })
    fs.writeFileSync(path.join(values.out, name), Buffer.from(data, 'base64'))
    console.log(`已保存 ${path.join(values.out, name)}`)
  }

  await send('Network.enable')
  await send('Network.setCookie', { name: cookieName, value: cookieValue, url: base })
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: base })
  await sleep(3000)
  // 活动页：顶部状态、她最近的信、动态的前几条
  await shot('activity.png', { x: 0, y: 0, width: 900, height: 1000 })

  // 日记页：切到「日记」，月历选中最近写过日记的一天，只截日记那张卡片
  const rect = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    ;[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === '日记').click()
    await wait(500)
    const days = [...document.querySelectorAll('[role=tabpanel] button[title$="篇"]')]
    days.at(-1)?.click()
    await wait(400)
    const r = document.querySelector('[role=tablist]').closest('.mantine-Paper-root').getBoundingClientRect()
    return { x: r.left - 12, y: r.top + window.scrollY - 12, width: r.width + 24, height: r.height + 24 }
  })()`)
  await shot('diary.png', rect)
  ws.close()
} finally {
  const exited = new Promise((r) => chrome.once('exit', r))
  chrome.kill()
  await Promise.race([exited, sleep(5000)])
}

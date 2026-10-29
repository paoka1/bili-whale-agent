import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { findFfmpeg } from '../src/ffmpeg.js'
import { captureFrames } from '../src/frames.js'
import { LoginExpiredError } from '../src/api.js'
import { TrafficError } from '../src/traffic.js'
import { fakeBili, json, viewData } from './helpers.js'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  // 原生 execFile 的 promisify 返回 { stdout, stderr }，测试替身保留这个约定。
  Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => new Promise((resolve, reject) => {
    execFile(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))
  }) })
  return { execFile }
})

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })

const CDN = 'https://upos.bilivideo.com/video.mp4?auth_key=SECRET'
const scenes = Array.from({ length: 9 }, (_, i) => `pts_time:${i * 10 + 4}`).join('\n')

function route(url: URL) {
  if (url.pathname === '/x/web-interface/wbi/view') return json({ code: 0, data: viewData({ duration: 90 }) })
  if (url.pathname === '/x/player/wbi/playurl') return json({ code: 0, data: { durl: [{ url: CDN }] } })
  if (url.hostname === 'upos.bilivideo.com') return new Response('分段视频内容', { headers: { 'content-type': 'video/mp4' } })
}

function fakeFfmpeg(sceneOutput = scenes, failSheet = false) {
  vi.stubEnv('FFMPEG', process.execPath)
  execFile.mockImplementation((_file: string, args: string[], _opt: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const output = args.at(-1)!
    if (output.endsWith('.jpg')) fs.writeFileSync(output, '图片')
    callback(failSheet && args.some((a) => a.includes('tile=')) ? new Error('SESS-SECRET JCT ffmpeg 内部错误') : null, sceneOutput, '')
  })
}

it('显式指定的 FFMPEG 不存在时返回 null', () => {
  const { dataDir } = fakeBili(() => undefined)
  vi.stubEnv('FFMPEG', path.join(dataDir, 'missing-ffmpeg'))
  expect(findFfmpeg()).toBeNull()
})

it('找不到 ffmpeg 时跳过看画面，不请求 B 站', async () => {
  vi.stubEnv('FFMPEG', '')
  vi.stubEnv('PATH', '')
  const { ctx, calls } = fakeBili(() => undefined)
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toEqual({ ok: false, reason: '未安装 ffmpeg，跳过看画面' })
  expect(calls).toHaveLength(0)
})

it('按 FFMPEG、PATH、数据目录 bin 的顺序查找', () => {
  const { dataDir } = fakeBili(() => undefined)
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const bin = path.join(dataDir, 'bin')
  const onPath = path.join(dataDir, 'path')
  fs.mkdirSync(bin)
  fs.mkdirSync(onPath)
  for (const dir of [bin, onPath]) fs.writeFileSync(path.join(dir, exe), '', { mode: 0o755 })
  vi.stubEnv('FFMPEG', '')
  vi.stubEnv('PATH', onPath)
  expect(findFfmpeg(dataDir)).toBe(path.join(onPath, exe))
  vi.stubEnv('FFMPEG', path.join(bin, exe))
  expect(findFfmpeg(dataDir)).toBe(path.join(bin, exe))
  vi.stubEnv('FFMPEG', '')
  vi.stubEnv('PATH', '')
  vi.stubEnv('BILI_WHALE_HOME', dataDir)
  expect(findFfmpeg()).toBe(path.join(bin, exe))
})

it('视频直链不在白名单时拒绝下载', async () => {
  vi.stubEnv('FFMPEG', process.execPath)
  const { ctx, calls } = fakeBili((url) => {
    if (url.pathname === '/x/web-interface/wbi/view') return json({ code: 0, data: viewData() })
    if (url.pathname === '/x/player/wbi/playurl') return json({ code: 0, data: { durl: [{ url: 'https://evil.com/video.mp4' }] } })
  })
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: false })
  expect(calls.every((c) => c.url.hostname === 'api.bilibili.com')).toBe(true)
  expect(fs.existsSync(path.join(ctx.dataDir, 'shots'))).toBe(false)
})

it('演练模式仍可取画面：签名获取 pc 直链、流式下载并拼默认九宫格', async () => {
  fakeFfmpeg()
  const { ctx, calls } = fakeBili(route)
  const result = await captureFrames(ctx, 'BV1AAAAAAAAA')
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  expect(result.frameTimes).toEqual([4, 14, 24, 34, 44, 54, 64, 74, 84])
  expect(result.imagePath).toMatch(/BV1AAAAAAAAA-.*-3x3\.jpg$/)
  expect(fs.readdirSync(path.dirname(result.imagePath))).toEqual([path.basename(result.imagePath)])
  const play = calls.find((c) => c.url.pathname === '/x/player/wbi/playurl')!
  expect(Object.fromEntries(play.url.searchParams)).toMatchObject({ cid: '202', qn: '80', fnval: '1', platform: 'pc', high_quality: '1' })
  expect(play.url.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/)
  const cdn = calls.find((c) => c.url.hostname === 'upos.bilivideo.com')!
  expect(cdn.url.href).toBe(CDN)
  expect(cdn.init.redirect).toBe('manual')
  expect(new Headers(cdn.init.headers).get('cookie')).toBeNull()
  expect(new Headers(cdn.init.headers).get('referer')).toBe('https://www.bilibili.com/')
  expect(new Headers(cdn.init.headers).get('range')).toBe('bytes=0-')
  expect(calls.every((c) => !c.init.method || c.init.method === 'GET')).toBe(true)
  expect(execFile.mock.calls.at(-1)![1]).toContain('scale=720:-1,tile=3x3')
  expect(execFile.mock.calls.every((c) => c[2].windowsHide && c[2].timeout > 0)).toBe(true)
  expect(execFile.mock.calls.flatMap((c) => c[1]).join(' ')).not.toMatch(/https?:|SESS-SECRET|JCT/)
})

it('没有场景变化时回退等间隔，支持 4x4 和自定义宽度', async () => {
  fakeFfmpeg('')
  const { ctx } = fakeBili(route)
  const result = await captureFrames(ctx, 'BV1AAAAAAAAA', { grid: '4x4', tile: 480 })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  expect(result.frameTimes).toEqual(Array.from({ length: 16 }, (_, i) => (i + 0.5) * 90 / 16))
  const filters = execFile.mock.calls.flatMap((c) => c[1]).filter((arg: string) => arg.includes('scene,'))
  expect(filters).toEqual([0.3, 0.15, 0.08].map((t) => `select='gt(scene,${t})',metadata=print:file=-`))
  expect(execFile.mock.calls.at(-1)![1]).toContain('scale=480:-1,tile=4x4')
  expect(result.imagePath).toMatch(/-4x4\.jpg$/)
})

it('主直链在白名单外时只下载白名单内的备用 CDN', async () => {
  fakeFfmpeg()
  const { ctx, calls } = fakeBili((url) => url.pathname === '/x/player/wbi/playurl'
    ? json({ code: 0, data: { durl: [{ url: 'https://pcdn.example.com/video.mp4', backup_url: ['https://evil.com/video.mp4', CDN] }] } }) : route(url))
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: true })
  expect(calls.every((c) => c.url.hostname === 'api.bilibili.com' || c.url.hostname === 'upos.bilivideo.com')).toBe(true)
})

it('变化点都在开头时仍覆盖视频中后段', async () => {
  fakeFfmpeg('pts_time:1\npts_time:2\npts_time:3\npts_time:0\npts_time:NaN\npts_time:1000')
  const { ctx } = fakeBili(route)
  const result = await captureFrames(ctx, 'BV1AAAAAAAAA')
  expect(result).toMatchObject({ ok: true, frameTimes: [3, 15, 25, 35, 45, 55, 65, 75, 85] })
})

it('场景探测失败时仍可用等间隔抽帧', async () => {
  fakeFfmpeg()
  execFile.mockImplementationOnce((_file: string, _args: string[], _opt: unknown, cb: (error: Error) => void) => cb(new Error('场景探测失败')))
  const { ctx } = fakeBili(route)
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: true, frameTimes: [5, 15, 25, 35, 45, 55, 65, 75, 85] })
})

it('拼图失败时删除原片、单帧和未完成的图片，错误不包含凭据', async () => {
  fakeFfmpeg(scenes, true)
  const { ctx } = fakeBili(route)
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toEqual({ ok: false, reason: 'ffmpeg 抽帧失败，跳过看画面' })
  expect(fs.readdirSync(path.join(ctx.dataDir, 'shots', 'video'))).toEqual([])
})

it.each(['HTTP', '空正文', '流中断'])('下载失败（%s）时清理临时文件', async (failure) => {
  fakeFfmpeg()
  const { ctx } = fakeBili((url) => {
    if (url.hostname !== 'upos.bilivideo.com') return route(url)
    if (failure === 'HTTP') return new Response('SESS-SECRET', { status: 500 })
    if (failure === '空正文') return new Response(null)
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error('SESS-SECRET')) } }))
  })
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toEqual({ ok: false, reason: '视频下载失败，跳过看画面' })
  expect(execFile).not.toHaveBeenCalled()
  expect(fs.readdirSync(path.join(ctx.dataDir, 'shots', 'video'))).toEqual([])
})

it('拦截跳转到白名单外的视频下载，不访问目标', async () => {
  fakeFfmpeg()
  const { ctx, calls } = fakeBili((url) => url.hostname === 'upos.bilivideo.com'
    ? new Response(null, { status: 302, headers: { location: 'https://evil.com/video.mp4' } }) : route(url))
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: false })
  expect(calls.some((c) => c.url.hostname === 'evil.com')).toBe(false)
  expect(execFile).not.toHaveBeenCalled()
  expect(fs.readdirSync(path.join(ctx.dataDir, 'shots', 'video'))).toEqual([])
})

it('允许白名单内相对跳转，保留 CDN 的无 cookie 请求', async () => {
  fakeFfmpeg()
  const { ctx, calls } = fakeBili((url) => {
    if (url.hostname === 'upos.bilivideo.com' && url.pathname === '/video.mp4') return new Response(null, { status: 302, headers: { location: '/next.mp4' } })
    return route(url)
  })
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: true })
  expect(calls.filter((c) => c.url.hostname === 'upos.bilivideo.com').map((c) => c.url.pathname)).toEqual(['/video.mp4', '/next.mp4'])
  expect(new Headers(calls.at(-1)!.init.headers).get('cookie')).toBeNull()
})

it('重定向循环有限次退出', async () => {
  fakeFfmpeg()
  const { ctx, calls } = fakeBili((url) => url.hostname === 'upos.bilivideo.com'
    ? new Response(null, { status: 302, headers: { location: CDN } }) : route(url))
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: false })
  expect(calls.filter((c) => c.url.hostname === 'upos.bilivideo.com')).toHaveLength(6)
  expect(fs.readdirSync(path.join(ctx.dataDir, 'shots', 'video'))).toEqual([])
})

it.each(['视频信息', '播放地址'])('%s登录失效要往上抛', async (stage) => {
  fakeFfmpeg()
  const endpoint = stage === '视频信息' ? '/x/web-interface/wbi/view' : '/x/player/wbi/playurl'
  const { ctx } = fakeBili((url) => url.pathname === endpoint ? json({ code: -101 }) : route(url))
  await expect(captureFrames(ctx, 'BV1AAAAAAAAA')).rejects.toBeInstanceOf(LoginExpiredError)
})

it('下载时风控暂停往上抛，仍清理临时文件', async () => {
  fakeFfmpeg()
  const { ctx } = fakeBili(route)
  const original = ctx.guard.fetch.bind(ctx.guard)
  ctx.guard.fetch = async (input, init) => {
    if (new URL(input).hostname === 'upos.bilivideo.com') throw new TrafficError('测试暂停')
    return original(input, init)
  }
  await expect(captureFrames(ctx, 'BV1AAAAAAAAA')).rejects.toBeInstanceOf(TrafficError)
  expect(fs.readdirSync(path.join(ctx.dataDir, 'shots', 'video'))).toEqual([])
})

it('只有 DASH 流时返回可降级结果', async () => {
  fakeFfmpeg()
  const { ctx } = fakeBili((url) => url.pathname === '/x/player/wbi/playurl'
    ? json({ code: 0, data: { dash: {} } }) : route(url))
  expect(await captureFrames(ctx, 'BV1AAAAAAAAA')).toMatchObject({ ok: false, reason: expect.stringContaining('DASH') })
  expect(execFile).not.toHaveBeenCalled()
})

it.each([
  ['../escape', {}], ['BV1AAAAAAAAA', { grid: '2x2' }],
  ['BV1AAAAAAAAA', { tile: 239 }], ['BV1AAAAAAAAA', { tile: 1281 }], ['BV1AAAAAAAAA', { tile: 720.5 }],
])('拒绝不安全或无效参数 %s %j', async (bvid, opt) => {
  fakeFfmpeg()
  const { ctx, calls } = fakeBili(route)
  // 模拟绕过 TypeScript 的外部工具输入。
  expect(await captureFrames(ctx, bvid, opt as Parameters<typeof captureFrames>[2])).toMatchObject({ ok: false })
  expect(calls).toHaveLength(0)
})

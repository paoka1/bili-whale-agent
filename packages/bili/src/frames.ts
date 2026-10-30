// 抽帧看画面。移植自 upstream/tools/commands/bili-watch.mjs。
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import { biliGet, biliHeaders, isFatalBiliError } from './api.js'
import type { BiliContext } from './context.js'
import { findFfmpeg } from './ffmpeg.js'
import { assertBiliUrl, isBiliApiHost } from './net.js'
import { dataPath } from './paths.js'

export type CaptureResult = { ok: true; imagePath: string; frameTimes: number[] } | { ok: false; reason: string }
export type CaptureOptions = { grid?: '3x3' | '4x4'; tile?: number }

const run = promisify(execFile)
const REDIRECTS = [301, 302, 303, 307, 308]

/** 每跳重定向都先校验域名；CDN 不带登录 cookie，视频只交给 ffmpeg 的本地输入。 */
async function download(ctx: BiliContext, input: URL, file: string): Promise<void> {
  let url = input
  const { cookie, ...headers } = biliHeaders(ctx)
  for (let hop = 0; hop <= 5; hop++) {
    const response = await ctx.guard.fetch(url, {
      headers: { ...headers, ...(isBiliApiHost(url) ? { cookie } : {}), range: 'bytes=0-' },
      redirect: 'manual',
    })
    if (REDIRECTS.includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('视频下载重定向缺少地址')
      url = assertBiliUrl(new URL(location, url))
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('视频下载失败')
    }
    // 2026-10-21 上游修复：长视频不能 arrayBuffer() 整条读入内存，必须流式写盘。
    await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), fs.createWriteStream(file, { flags: 'wx' }))
    return
  }
  throw new Error('视频下载重定向次数过多')
}

async function frameTimes(ffmpeg: string, file: string, duration: number, count: number): Promise<number[]> {
  let scenes: number[] = []
  // 2026-10-14 上游实测：录屏变化平缓，要逐级降低阈值；探测失败时退回等间隔。
  for (const threshold of [0.3, 0.15, 0.08]) {
    try {
      const { stdout } = await run(ffmpeg, ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', file,
        '-vf', `select='gt(scene,${threshold})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
      scenes = [...new Set([...stdout.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])))]
        .filter((t) => Number.isFinite(t) && t > 0.2 && t < duration)
      if (scenes.length >= count) break
    } catch { break }
  }
  // 2026-10-14 上游修复：均匀时间点作骨架，再吸附到半格内最近的变化点，避免漏掉中段。
  const half = duration / count / 2
  return Array.from({ length: count }, (_, i) => {
    const uniform = (i + 0.5) * duration / count
    const near = scenes.filter((t) => Math.abs(t - uniform) <= half)
    return near.length ? near.reduce((best, t) => Math.abs(t - uniform) < Math.abs(best - uniform) ? t : best) : uniform
  })
}

/** 返回拼图的本地路径。普通失败可降级，风控暂停与登录失效继续交给调度器。 */
export async function captureFrames(ctx: BiliContext, bvid: string, opt: CaptureOptions = {}): Promise<CaptureResult> {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, reason: '无效的 BV 号' }
  const grid = opt.grid ?? '3x3'
  const tile = opt.tile ?? 720
  if (grid !== '3x3' && grid !== '4x4') return { ok: false, reason: '画面网格必须是 3x3 或 4x4' }
  if (!Number.isInteger(tile) || tile < 240 || tile > 1280) return { ok: false, reason: '每格宽度必须是 240–1280 的整数' }
  const ffmpeg = findFfmpeg(ctx.dataDir)
  if (!ffmpeg) return { ok: false, reason: '未安装 ffmpeg，跳过看画面' }

  let tmp: string | undefined
  let imagePath: string | undefined
  let ok = false
  let reason = '视频信息获取失败，跳过看画面'
  try {
    const view = await biliGet<{ cid: number; duration: number }>(ctx, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
    const cid = Number(view.data?.cid)
    const duration = Number(view.data?.duration)
    if (view.code !== 0 || !Number.isSafeInteger(cid) || cid <= 0 || !Number.isFinite(duration) || duration <= 0) return { ok: false, reason }

    // 2026-10-14 上游实测：html5 + qn=32 会降到 360p；pc + qn=80 可拿到 720p mp4。
    reason = '未获取到视频直链，可能需要登录或视频仅提供 DASH 流'
    const play = await biliGet<{ durl?: { url: string; backup_url?: string[] }[] }>(ctx,
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`)
    const stream = play.data?.durl?.[0]
    if (play.code !== 0 || !stream?.url) return { ok: false, reason }
    reason = '视频直链不在 B 站域名白名单内，跳过看画面'
    // 首选地址可能落在白名单外的 PCDN 域名；只从 B 站给出的主/备用地址里选择白名单内的 CDN。
    const urls: URL[] = []
    for (const input of [stream.url, ...(stream.backup_url ?? [])]) {
      try { urls.push(assertBiliUrl(input)) } catch { /* 不请求白名单外的地址 */ }
    }
    if (!urls.length) return { ok: false, reason }

    reason = '无法创建抽帧文件，跳过看画面'
    const outDir = path.resolve(dataPath(ctx.dataDir, 'shots', 'video'))
    fs.mkdirSync(outDir, { recursive: true })
    tmp = fs.mkdtempSync(path.join(outDir, '.frames-'))
    const file = path.join(tmp, 'video.mp4')
    const stamp = `${new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    imagePath = path.join(outDir, `${bvid}-${stamp}-${grid}.jpg`)
    reason = '视频下载失败，跳过看画面'
    // 2026-10-30 服务器实测：部分网络把主 CDN 302 到白名单外的运营商缓存，备用 CDN 仍可直连，逐个尝试。
    let downloaded = false
    for (const url of urls) {
      try {
        await download(ctx, url, file)
        downloaded = true
        break
      } catch (e) {
        if (isFatalBiliError(e)) throw e
        await fs.promises.rm(file, { force: true })
      }
    }
    if (!downloaded) return { ok: false, reason }

    reason = 'ffmpeg 抽帧失败，跳过看画面'
    const count = grid === '3x3' ? 9 : 16
    const times = await frameTimes(ffmpeg, file, duration, count)
    for (const [i, t] of times.entries()) {
      await run(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', file,
        '-frames:v', '1', '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)],
      { windowsHide: true, timeout: 60_000 })
    }
    await run(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'),
      '-vf', `scale=${tile}:-1,tile=${grid}`, '-frames:v', '1', imagePath], { windowsHide: true, timeout: 120_000 })
    if (!fs.statSync(imagePath).size) throw new Error('拼图未生成')
    ok = true
    return { ok: true, imagePath, frameTimes: times }
  } catch (e) {
    if (isFatalBiliError(e)) throw e
    return { ok: false, reason }
  } finally {
    // 临时目录由 mkdtemp 在 shots/video 内生成；成功或失败都删除原片和单帧。
    // 异步 rm 避免 Node 24/Windows 在含中文的路径上同步删除无效的问题。
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true })
    if (!ok && imagePath) await fs.promises.rm(imagePath, { force: true })
  }
}

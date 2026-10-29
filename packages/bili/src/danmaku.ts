// 弹幕热区：观众在哪炸了。移植自 upstream/tools/commands/debrief.mjs 第 ④ 段。
import zlib from 'node:zlib'
import { biliFetchRaw } from './api.js'
import type { BiliContext } from './context.js'
import type { SubtitleLine } from './subtitles.js'
import { getVideo } from './video.js'

export type DanmakuHotspot = { t: number; count: number; samples: string[]; line?: string }
export type DanmakuSummary = { total: number; effective: number; hotspots: DanmakuHotspot[] }

// 2026-10-14 实测：comment.bilibili.com 返回不带 content-encoding 头的 deflate 流，fetch 不会自动解
function decodeXml(buf: Buffer): string {
  const xml = buf.toString('utf8')
  if (xml.includes('<d ') || xml.includes('<i>')) return xml
  for (const fn of [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync, zlib.brotliDecompressSync]) {
    try { const out = fn(buf).toString('utf8'); if (out.includes('<d ') || out.includes('<i>')) return out } catch { /* 换下一种 */ }
  }
  return ''
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** 字幕里覆盖时间点 t 的那句；没有覆盖的就取 t 之前最近的一句 */
function lineAt(lines: SubtitleLine[], t: number): string | undefined {
  let best: SubtitleLine | undefined
  for (const l of lines) if (l.t <= t && (!best || l.t > best.t)) best = l
  return best?.text
}

/**
 * 按 bucketSec 分桶，剔除刷屏后取有效条数最多的 top 段。
 * 注意 XML 只给采样集（实测标称 26 万条的视频只给 600 条），total 不是全量。
 * 传入字幕时，每段附上桶中点对应的那句字幕。
 */
export async function getDanmakuHotspots(ctx: BiliContext, bvid: string, opt: { bucketSec?: number; top?: number; subtitleLines?: SubtitleLine[] } = {}): Promise<DanmakuSummary> {
  const bucketSec = opt.bucketSec ?? 30
  const top = opt.top ?? 5
  const { cid } = await getVideo(ctx, bvid)
  const raw = await biliFetchRaw(ctx, `https://comment.bilibili.com/${cid}.xml`)
  const danmaku = raw ? [...decodeXml(raw).matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)]
    .map((m) => ({ t: Number(m[1]!.split(',')[0]), text: unescape(m[2]!) }))
    .filter((x) => Number.isFinite(x.t)) : []
  if (!danmaku.length) return { total: 0, effective: 0, hotspots: [] }

  // 刷屏波：归一化后单句 ≥20 条且占全片 >30%（实测仪式弹幕连带变体能吃掉 87%）。
  // 整条都是标点 / 表情的（如「?」×500）归一化后是空串，一律算刷屏（实测漏检过）。
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '')
  const keyCounts = new Map<string, number>()
  for (const x of danmaku) { const k = norm(x.text) || '<纯符号>'; keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1) }
  const spamKeys = [...keyCounts].filter(([, c]) => c >= 20 && c / danmaku.length > 0.3).map(([k]) => k)
  const isSpam = (text: string) => { const k = norm(text); return k.length === 0 || spamKeys.some((s) => k.includes(s)) }

  const buckets = new Map<number, string[]>()
  for (const x of danmaku) {
    if (isSpam(x.text)) continue
    const k = Math.floor(x.t / bucketSec) * bucketSec
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(x.text)
  }
  const effective = [...buckets.values()].reduce((n, b) => n + b.length, 0)
  // 按剔刷屏后的条数排：否则开场仪式弹幕会把真正的名场面挤下去
  const hotspots = [...buckets].sort((a, b) => b[1].length - a[1].length).slice(0, top).map(([t, texts]) => {
    const counts = new Map<string, number>()
    for (const s of texts) counts.set(s, (counts.get(s) ?? 0) + 1)
    const samples = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, c]) => (c > 1 ? `${s}×${c}` : s))
    const line = opt.subtitleLines?.length ? lineAt(opt.subtitleLines, t + bucketSec / 2) : undefined
    return { t, count: texts.length, samples, ...(line ? { line } : {}) }
  })
  return { total: danmaku.length, effective, hotspots }
}

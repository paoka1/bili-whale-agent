// 搜索视频（WBI 签名 + cookie）。移植自 upstream/tools/commands/search.mjs。
import { biliGet } from './api.js'
import type { BiliContext } from './context.js'

export type VideoCard = { bvid: string; title: string; author: string; mid: string; play: number; danmaku: number; durationSec: number; pubdate: number }

type SearchItem = { bvid: string; title?: string; author?: string; mid?: number | string; play?: number | string; danmaku?: number | string; video_review?: number | string; duration?: string; pubdate?: number }

export const stripTags = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, '')

/** "mm:ss" / "h:mm:ss" → 秒 */
export function durationOf(s: unknown): number {
  const p = String(s ?? '').split(':').map(Number)
  if (p.some((n) => !Number.isFinite(n))) return 0
  return p.reduce((sum, n) => sum * 60 + n, 0)
}

/** 2026-10-22 修（上游）：接口失败必须报错，只有「接口成功但没结果」才返回空数组。 */
export async function searchVideos(ctx: BiliContext, keyword: string, opt: { order?: 'click' | 'pubdate'; page?: number } = {}): Promise<VideoCard[]> {
  const page = opt.page ?? 1
  if (!Number.isInteger(page) || page < 1) throw new Error(`页码必须是正整数：${page}`)
  const q = new URLSearchParams({ search_type: 'video', keyword, page: String(page), ...(opt.order ? { order: opt.order } : {}) })
  const r = await biliGet<{ result?: SearchItem[] }>(ctx, `https://api.bilibili.com/x/web-interface/wbi/search/type?${q}`, { wbi: true })
  if (r.code !== 0) throw new Error(`搜索失败（code=${r.code}）：${r.message}`)
  return (r.data?.result ?? []).filter((it) => it.bvid).map((it) => ({
    bvid: it.bvid,
    title: stripTags(it.title),
    author: String(it.author ?? ''),
    mid: String(it.mid ?? ''),
    play: Number(it.play ?? 0) || 0,
    danmaku: Number(it.danmaku ?? it.video_review ?? 0) || 0,
    durationSec: durationOf(it.duration),
    pubdate: Number(it.pubdate ?? 0),
  }))
}

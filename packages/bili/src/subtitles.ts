// 官方字幕（带时间戳）。移植自 upstream/tools/commands/subtitles.mjs。
// 实测要点（2026-10-14）：
//   1. 必须走 WBI 签名的 /x/player/wbi/v2，旧 /x/player/v2 给的 subtitle_url 缺 auth_key → CDN 403。
//   2. auth_key 分钟级有效，拿到就下载，URL 不能截断（尾部还有 -0-<hex>）。
//   3. 匿名拿不到 AI 字幕，必须带登录 cookie（biliGet 已带）。
//   4. 兜底端点 /x/v2/subtitle/web/view 没字幕时会回 HTML —— 当作「没有字幕」，不报错。
import { biliFetchRaw, biliGet } from './api.js'
import type { BiliContext } from './context.js'
import { getVideo } from './video.js'

export type SubtitleLine = { t: number; text: string }
type Track = { lan: string; subtitle_url: string }
type PlayerData = { subtitle?: { subtitles?: Track[] } }

/** 没有字幕轨道（只有烧进画面的硬字幕）或下载失败时返回 null。 */
export async function getSubtitles(ctx: BiliContext, bvid: string): Promise<{ lang: string; lines: SubtitleLine[] } | null> {
  const { aid, cid } = await getVideo(ctx, bvid)
  const main = await biliGet<PlayerData>(ctx, `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`, { wbi: true })
  let tracks = main.data?.subtitle?.subtitles ?? []
  if (!tracks.length) {
    const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))
    const alt = await biliGet<PlayerData>(ctx, `https://api.bilibili.com/x/v2/subtitle/web/view?oid=${aid}&pid=${aid}&context_ext=${ext}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`)
    tracks = alt.data?.subtitle?.subtitles ?? []
  }
  const pick = tracks.find((s) => s.lan === 'ai-zh') ?? tracks.find((s) => s.lan === 'zh-CN') ?? tracks.find((s) => String(s.lan).startsWith('zh')) ?? tracks[0]
  if (!pick) return null

  const url = String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
  const raw = await biliFetchRaw(ctx, url)
  if (!raw) return null
  let body: { from: number; content: string }[] = []
  try { body = JSON.parse(raw.toString('utf8')).body ?? [] } catch { return null }
  if (!Array.isArray(body) || !body.length) return null
  return { lang: String(pick.lan), lines: body.map((l) => ({ t: Number(l.from), text: String(l.content ?? '') })) }
}

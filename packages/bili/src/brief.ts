// 「看懂视频」的文字四路：元信息、字幕、弹幕热区、热评。移植自 upstream/tools/commands/debrief.mjs（画面那一路在 frames.ts）。
// 脚本只备素材，不作判断；结论由模型合成。
import { isFatalBiliError } from './api.js'
import { getComments, type CommentItem } from './comments.js'
import type { BiliContext } from './context.js'
import { getDanmakuHotspots, type DanmakuSummary } from './danmaku.js'
import { getSubtitles } from './subtitles.js'
import { getVideo, type VideoMeta } from './video.js'

export type VideoBrief = { meta: VideoMeta; subtitles: string | null; danmaku: DanmakuSummary; comments: CommentItem[] }

const SUBTITLE_MAX = 6000
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** 某一路失败就留空，但风控暂停和登录失效往上抛 */
async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p } catch (e) { if (isFatalBiliError(e)) throw e; return fallback }
}

/** 视频不存在时抛错。字幕为 `[mm:ss] 文本` 逐行，超过 6000 字截断并以「…」结尾。 */
export async function briefVideo(ctx: BiliContext, bvid: string, opt: { comments?: number } = {}): Promise<VideoBrief> {
  const meta = await getVideo(ctx, bvid)
  const subs = await soft(getSubtitles(ctx, bvid), null)
  const danmaku = await soft(getDanmakuHotspots(ctx, bvid, { subtitleLines: subs?.lines }), { total: 0, effective: 0, hotspots: [] })
  const comments = await soft(getComments(ctx, bvid, { limit: opt.comments ?? 8, maxChars: 160 }), [])
  let subtitles = subs ? subs.lines.map((l) => `[${mmss(l.t)}] ${l.text}`).join('\n') : null
  if (subtitles && subtitles.length > SUBTITLE_MAX) subtitles = subtitles.slice(0, SUBTITLE_MAX - 1) + '…'
  return { meta, subtitles, danmaku, comments }
}

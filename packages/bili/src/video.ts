// 视频元信息：view 接口 + 标签。两者都按元信息缓存 24 小时。
import { biliGet } from './api.js'
import type { BiliContext } from './context.js'

export type VideoMeta = {
  bvid: string
  aid: number
  title: string
  desc: string
  owner: { mid: string; name: string }
  durationSec: number
  pubdate: number
  stat: { view: number; danmaku: number; like: number; favorite: number; reply: number }
  tags: string[]
  cid: number
  coverUrl: string
}

type ViewData = {
  bvid: string; aid: number; cid: number; title: string; desc?: string; pic?: string; duration: number; pubdate: number
  owner: { mid: number | string; name: string }
  stat: Record<'view' | 'danmaku' | 'like' | 'favorite' | 'reply', number>
}

/** 标题、简介、UP、时长、数据、标签。视频不存在或接口失败时抛错。 */
export async function getVideo(ctx: BiliContext, bvid: string): Promise<VideoMeta> {
  const view = await biliGet<ViewData>(ctx, `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
  if (view.code !== 0 || !view.data) throw new Error(`视频信息获取失败（code=${view.code}）：${view.message}`)
  const d = view.data
  const tag = await biliGet<{ tag_name: string }[]>(ctx, `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`)
  const pic = String(d.pic ?? '')
  return {
    bvid: d.bvid,
    aid: Number(d.aid),
    title: String(d.title ?? ''),
    desc: String(d.desc ?? ''),
    owner: { mid: String(d.owner?.mid ?? ''), name: String(d.owner?.name ?? '') },
    durationSec: Number(d.duration ?? 0),
    pubdate: Number(d.pubdate ?? 0),
    stat: { view: Number(d.stat?.view ?? 0), danmaku: Number(d.stat?.danmaku ?? 0), like: Number(d.stat?.like ?? 0), favorite: Number(d.stat?.favorite ?? 0), reply: Number(d.stat?.reply ?? 0) },
    tags: tag.code === 0 && Array.isArray(tag.data) ? tag.data.map((t) => String(t.tag_name)) : [],
    cid: Number(d.cid),
    coverUrl: pic.replace(/^(https?:)?\/\//, 'https://'),
  }
}

// 热评 / 最新评论（只读）。移植自 upstream/tools/commands/comments.mjs。
// 实测口径：oid 是 aid 不是 BV；sort=2 是热度序，sort=0 是时间序。
import { biliGet } from './api.js'
import type { BiliContext } from './context.js'
import { getVideo } from './video.js'

export type CommentItem = { rpid: string; mid: string; uname: string; text: string; like: number; ctime: number; replies: number; tag?: '置顶' | 'UP置顶' }

type Reply = { rpid?: number | string; member?: { uname?: string; mid?: number | string }; like?: number; rcount?: number; ctime?: number; content?: { message?: string } }
type ReplyPage = { top?: Reply[] | null; upper?: { top?: Reply | null }; replies?: Reply[] | null }

/** 第一页评论，置顶在前。接口失败时抛错。 */
export async function getComments(ctx: BiliContext, bvid: string, opt: { sort?: 'hot' | 'time'; limit?: number; maxChars?: number } = {}): Promise<CommentItem[]> {
  const ps = Math.min(50, Math.max(1, Math.floor(opt.limit ?? 20) || 20))
  const maxChars = Math.max(40, Math.floor(opt.maxChars ?? 200) || 200)
  const sort = opt.sort === 'time' ? 0 : 2
  const { aid } = await getVideo(ctx, bvid)
  const rep = await biliGet<ReplyPage>(ctx, `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=${sort}&ps=${ps}&pn=1`)
  if (rep.code !== 0) throw new Error(`评论获取失败（code=${rep.code}）：${rep.message}`)

  const one = (r: Reply, tag?: CommentItem['tag']): CommentItem => ({
    rpid: String(r.rpid ?? ''),
    mid: String(r.member?.mid ?? ''),
    uname: String(r.member?.uname ?? '匿名'),
    text: String(r.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars),
    like: Number(r.like ?? 0),
    ctime: Number(r.ctime ?? 0),
    replies: Number(r.rcount ?? 0),
    ...(tag ? { tag } : {}),
  })
  const d = rep.data ?? {}
  return [
    ...(Array.isArray(d.top) ? d.top.map((r) => one(r, '置顶')) : []),
    ...(d.upper?.top ? [one(d.upper.top, 'UP置顶')] : []),
    ...(Array.isArray(d.replies) ? d.replies.map((r) => one(r)) : []),
  ]
}

// 评论与主人回复。移植自 upstream/tools/commands/comment.mjs。
import { biliGet, biliPost, isFatalBiliError, signWbi, wbiKeysFromNav } from './api.js'
import type { BiliContext } from './context.js'
import { explainCode } from './creds.js'
import { checkShare, readQuota, recordWrite } from './quota.js'
import { getVideo } from './video.js'
import { account, dryPreview, isBvid, isId, refuse, writeAction, type WriteResult } from './write.js'

export type CommentOptions = { bvid: string; message: string; share?: { reason: string; score: number; rank: number }; root?: string; parent?: string }
type Reply = { rpid?: string | number; rpid_str?: string; mid?: string | number; member?: { mid?: string | number }; content?: { message?: string } }
type ReplyPage = { root?: Reply; replies?: Reply[] | null }
const replyId = (r: Reply) => String(r.rpid_str ?? r.rpid ?? '')

async function videoOid(ctx: BiliContext, bvid: string): Promise<string> {
  const { aid } = await getVideo(ctx, bvid)
  if (!Number.isSafeInteger(aid) || aid <= 0) return refuse('无法确认视频 aid')
  return String(aid)
}

/** 2026-10-22 上游修复：顶层评论在 data.root 中；root=0 要由调用方归一为 parent。 */
export async function readReply(ctx: BiliContext, oid: string, root: string, rpid: string): Promise<Reply | null> {
  for (let pn = 1; pn <= 4; pn++) {
    const result = await biliGet<ReplyPage>(ctx, `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${oid}&root=${root}&pn=${pn}&ps=20`)
    if (result.code !== 0) return null
    if (result.data?.root && replyId(result.data.root) === rpid) return result.data.root
    const replies = result.data?.replies ?? []
    const hit = replies.find((r) => replyId(r) === rpid)
    if (hit) return hit
    if (!replies.length) break
  }
  return null
}

/** 审批也复用发送、记账和署名复核；只供包内调用，不导出到公共入口。 */
export async function publishComment(ctx: BiliContext, opt: { bvid: string; oid: string; message: string; root?: string; parent?: string; share?: boolean }, onSent?: () => void): Promise<WriteResult> {
  const me = await account(ctx)
  const form: Record<string, string> = { type: '1', oid: opt.oid, message: opt.message, plat: '1' }
  if (opt.root) form.root = opt.root
  if (opt.parent) form.parent = opt.parent
  let url = 'https://api.bilibili.com/x/v2/reply/add'
  if (me.wbi_img) {
    const signed = new URLSearchParams(signWbi({ ...form, csrf: ctx.cred.bili_jct }, wbiKeysFromNav(me.wbi_img), ctx.now()))
    url += `?w_rid=${signed.get('w_rid')}&wts=${signed.get('wts')}`
  }
  const result = await biliPost<{ rpid?: string | number; rpid_str?: string }>(ctx, url, form)
  if (result.code !== 0) return { status: 'refused', reason: `评论发送失败：${explainCode(result.code)}` }
  const rpid = String(result.data?.rpid_str ?? result.data?.rpid ?? '')
  recordWrite(ctx, { type: 'comment', target: `BV:${opt.bvid}`, note: opt.message, auto: true, share: opt.share === true })
  onSent?.()
  // 已收到成功响应就不能退回草稿重发；复核暂不可见时把情况一并返回。
  if (!isId(rpid)) return { status: 'sent', reason: '评论已发送，但响应缺少评论 ID，请人工核查，勿重复发送' }
  let found: Reply | null = null
  try {
    found = await readReply(ctx, opt.oid, opt.root ?? rpid, rpid)
    // 2026-10-19 上游修复：顶层评论还要查主列表，不能只查楼中楼。
    if (!found && !opt.parent) {
      for (let pn = 1; pn <= 3; pn++) {
        const main = await biliGet<ReplyPage>(ctx, `https://api.bilibili.com/x/v2/reply?type=1&oid=${opt.oid}&pn=${pn}&ps=20&sort=0`)
        if (main.code !== 0) break
        const replies = main.data?.replies ?? []
        found = replies.find((r) => replyId(r) === rpid) ?? null
        if (found || !replies.length) break
      }
    }
  } catch (e) { if (isFatalBiliError(e)) throw e }
  if (!found) return { status: 'sent', rpid, reason: '评论已发送，暂未回读到，可能审核中；请核查，勿重复发送' }
  if (String(found.mid ?? found.member?.mid ?? '') !== me.mid || found.content?.message !== opt.message) {
    return { status: 'sent', rpid, reason: '评论已发送，但署名或正文复核未通过，请人工核查，勿重复发送' }
  }
  return { status: 'sent', rpid }
}

export async function postComment(ctx: BiliContext, opt: CommentOptions): Promise<WriteResult> {
  return writeAction(ctx, async () => {
    if (!isBvid(opt.bvid)) return refuse('无效的 BV 号')
    if (typeof opt.message !== 'string' || !opt.message.trim()) return refuse('评论正文不能为空')
    let message = opt.message.trim()
    const root = opt.parent && (!opt.root || opt.root === '0') ? opt.parent : opt.root
    if ((opt.parent && !isId(opt.parent)) || (root && !isId(root)) || (root && !opt.parent)) return refuse('回复需要有效的 root 和 parent')
    readQuota(ctx.dataDir)
    if (opt.share) {
      const check = checkShare(ctx, { ...opt.share, bvid: opt.bvid })
      if (!check.ok) return { status: 'refused', reason: check.reason }
      if (!isId(ctx.settings.owner.mid) || !ctx.settings.owner.name.trim()) return refuse('分享评论需要先配置主人 mid 和昵称')
      const prefix = `@${ctx.settings.owner.name} `
      if (!message.startsWith(prefix)) {
        if (message.includes('@')) return refuse('分享评论必须以 @主人昵称 开头')
        message = prefix + message
      }
    }
    if (message.length > 1000) return refuse('评论正文不能超过 1000 字')
    let oid: string | undefined
    if (opt.parent) {
      if (!isId(ctx.settings.owner.mid)) return refuse('回复非主人只能写草稿')
      oid = await videoOid(ctx, opt.bvid)
      const parent = await readReply(ctx, oid, root!, opt.parent)
      if (!parent || String(parent.mid ?? parent.member?.mid ?? '') !== ctx.settings.owner.mid) return refuse('回复非主人只能写草稿')
    }
    if (ctx.dryRun) return dryPreview(ctx, `BV:${opt.bvid}`, message)
    oid ??= await videoOid(ctx, opt.bvid)
    return publishComment(ctx, { bvid: opt.bvid, oid, message, root, parent: opt.parent, share: !!opt.share })
  })
}

// 私信只给主人、每天锁定一个收信人、必须互关。移植自 upstream/tools/commands/dm.mjs。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { biliGet, biliPost } from './api.js'
import type { BiliContext } from './context.js'
import { explainCode } from './creds.js'
import { dataPath } from './paths.js'
import { checkShare, readQuota, recordWrite, type ShareOptions } from './quota.js'
import { writeJsonAtomic } from './store.js'
import { account, dryPreview, isId, isObject, localDay, readState, refuse, validAt, writeAction, type WriteResult } from './write.js'

export type DmOptions = { message: string; share?: ShareOptions }
type DmQuota = { date: string; mid: string; count: number; at: string }

function loadQuota(dataDir: string): DmQuota {
  const q = readState<unknown>(dataDir, 'dm-quota.json', { date: '', mid: '', count: 0, at: '' })
  if (!isObject(q) || typeof q.date !== 'string' || (q.date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(q.date))
    || (q.mid !== '' && !isId(q.mid)) || !Number.isSafeInteger(q.count) || Number(q.count) < 0
    || (q.at !== '' && !validAt(q.at))) return refuse('dm-quota.json 私信账本损坏，停止发送')
  return q as DmQuota
}

/** 2026-10-22 上游修复：设备 ID 只生成一次并持久化，不能每条私信都模拟换设备。 */
function stableDevId(dataDir: string): string {
  const file = dataPath(dataDir, 'dev_id')
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    if (/^WEB-[0-9A-F-]{20,}$/i.test(value)) return value
    return refuse('私信设备 ID 损坏，请检查 dev_id，停止发送')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const value = 'WEB-' + randomUUID().toUpperCase()
  fs.writeFileSync(file, value + '\n', { mode: 0o600, flag: 'wx' })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 不支持 POSIX 权限 */ }
  return value
}

export async function dmOwner(ctx: BiliContext, opt: DmOptions): Promise<WriteResult> {
  return writeAction(ctx, async () => {
    // 入口不接收任何收信人参数，始终取配置值，且在异步请求前固定本次目标。
    const owner = ctx.settings.owner.mid
    if (!isId(owner)) return refuse('私信需要先配置主人 mid')
    if (typeof opt.message !== 'string' || !opt.message.trim()) return refuse('私信正文不能为空')
    let message = opt.message.trim()
    readQuota(ctx.dataDir)
    if (opt.share) {
      const check = checkShare(ctx, opt.share)
      if (!check.ok) return { status: 'refused', reason: check.reason }
      const link = `https://www.bilibili.com/video/${opt.share.bvid}`
      if (!message.includes(link)) message += `\n${link}`
    }
    if (message.length > 300) return refuse('私信正文不能超过 300 字')
    const q = loadQuota(ctx.dataDir)
    if (q.date === localDay(ctx.now()) && q.mid && q.mid !== owner) return refuse('今天已锁定其他收信人，一天只能私信一个收信人')
    const me = await account(ctx)
    if (me.mid === owner) return refuse('不能给自己发私信，请将主人设置为另一个互关账号')
    const relation = await biliGet<{ attribute?: number }>(ctx, `https://api.bilibili.com/x/relation?fid=${owner}`, { noCache: true })
    if (relation.code !== 0) return refuse(`无法确认互关关系：${explainCode(relation.code)}`)
    if (relation.data?.attribute !== 6) return refuse('私信通道要求双方互相关注')
    if (ctx.dryRun) return dryPreview(ctx, `dm:${owner}`, message)
    const devId = stableDevId(ctx.dataDir)
    const date = localDay(ctx.now())
    const used = q.date === date ? q.count : 0
    // 发出前先锁住收信人：网络结果不确定时，换 owner 也不能绕过当天的单收信人限制。
    const locked = { date, mid: owner, count: used, at: new Date(ctx.now()).toISOString() }
    writeJsonAtomic(dataPath(ctx.dataDir, 'dm-quota.json'), locked)
    const result = await biliPost(ctx, 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      'msg[sender_uid]': me.mid, 'msg[receiver_id]': owner, 'msg[receiver_type]': '1', 'msg[msg_type]': '1',
      'msg[msg_status]': '0', 'msg[timestamp]': String(Math.floor(ctx.now() / 1000)), 'msg[dev_id]': devId,
      'msg[content]': JSON.stringify({ content: message }),
    }, { waitWriteMs: 180000 })
    if (result.code !== 0) return { status: 'refused', reason: `私信发送失败：${explainCode(result.code)}` }
    writeJsonAtomic(dataPath(ctx.dataDir, 'dm-quota.json'), { ...locked, count: used + 1 })
    recordWrite(ctx, { type: 'dm', target: opt.share ? `BV:${opt.share.bvid}` : `dm:${owner}`, note: message, auto: true, share: !!opt.share })
    return { status: 'sent' }
  })
}

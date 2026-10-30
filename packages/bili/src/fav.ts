// 收藏闸门。移植自 upstream/tools/commands/fav.mjs。
import { biliGet, biliPost } from './api.js'
import type { BiliContext } from './context.js'
import { explainCode } from './creds.js'
import { dataPath } from './paths.js'
import { readQuota, recordWrite } from './quota.js'
import { writeJsonAtomic } from './store.js'
import { getVideo } from './video.js'
import { account, DAY_MS, dryPreview, isBvid, isObject, localDay, readState, refuse, validAt, writeAction, type WriteResult } from './write.js'

export type FavItem = { bvid: string; aid: number; title: string; up: string; at: string; reason: string; kind: string; favId?: number }
export type FavoriteOptions = { bvid: string; reason: string; kind?: string; better?: boolean }
const firstWord = (reason: string) => reason.trim().split(/[\s，。！？、,.:：;；/]+/)[0]!

/** 兼容上游以 bv 命名的旧记录，返回统一的 bvid 字段供 feed 使用。 */
export function listFavorites(dataDir: string): FavItem[] {
  const db = readState<unknown>(dataDir, 'favorites.json', { items: [] })
  if (!isObject(db) || !Array.isArray(db.items)) return refuse('favorites.json 收藏账本损坏，停止写入')
  return db.items.map((item: unknown) => {
    if (!isObject(item) || !isBvid(item.bvid ?? item.bv) || !Number.isSafeInteger(item.aid) || Number(item.aid) <= 0
      || !validAt(item.at) || typeof item.reason !== 'string' || typeof item.kind !== 'string'
      || typeof item.title !== 'string' || typeof item.up !== 'string'
      || (item.favId !== undefined && (!Number.isSafeInteger(item.favId) || Number(item.favId) <= 0))) return refuse('favorites.json 收藏记录损坏，停止写入')
    return { ...item, bvid: item.bvid ?? item.bv } as FavItem
  })
}

export async function addFavorite(ctx: BiliContext, opt: FavoriteOptions): Promise<WriteResult> {
  return writeAction(ctx, async () => {
    if (!isBvid(opt.bvid)) return refuse('无效的 BV 号')
    if (typeof opt.reason !== 'string' || opt.reason.trim().length < 6) return refuse('收藏理由至少需要 6 字')
    const reason = opt.reason.trim()
    const word = firstWord(reason)
    const kind = opt.kind?.trim() || word
    if (!word || !kind) return refuse('收藏需要有效的类别')
    const items = listFavorites(ctx.dataDir)
    readQuota(ctx.dataDir)
    if (items.filter((row) => localDay(row.at) === localDay(ctx.now())).length >= 3) return refuse('每天最多收藏 3 条')
    if (items.some((row) => row.bvid === opt.bvid && ctx.now() - Date.parse(row.at) < 30 * DAY_MS)) return refuse('同一视频 30 天内只能收藏一次')
    // 理由首词也参与判同类，避免只改 kind 就绕过已有两条的限制。
    if (items.filter((row) => row.kind === kind || firstWord(row.reason) === word).length >= 2 && opt.better !== true) {
      return refuse('同类已收藏至少 2 条，只有明显更好（better=true）才可继续收藏')
    }
    if (ctx.dryRun) return dryPreview(ctx, `BV:${opt.bvid}`, `收藏 ${opt.bvid}：${reason}（${kind}）`)
    const me = await account(ctx)
    const meta = await getVideo(ctx, opt.bvid)
    if (!Number.isSafeInteger(meta.aid) || meta.aid <= 0) return refuse('无法确认视频 aid')
    const folders = await biliGet<{ list?: { id: number; title: string; attr?: number }[] }>(ctx,
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${me.mid}`)
    if (folders.code !== 0) return refuse(`获取收藏夹失败：${explainCode(folders.code)}`)
    const list = folders.data?.list ?? []
    const folder = list.find((f) => /默认/.test(f.title)) ?? list[0]
    if (!folder || !Number.isSafeInteger(folder.id) || folder.id <= 0) return refuse('当前账号没有可用的收藏夹，请先在 B 站创建收藏夹')
    const result = await biliPost(ctx, 'https://api.bilibili.com/x/v3/fav/resource/deal', {
      rid: String(meta.aid), type: '2', add_media_ids: String(folder.id), del_media_ids: '',
    }, { waitWriteMs: 180000 })
    if (result.code !== 0) return { status: 'refused', reason: `收藏失败：${explainCode(result.code)}` }
    items.push({ bvid: opt.bvid, aid: meta.aid, title: meta.title, up: meta.owner.name, at: new Date(ctx.now()).toISOString(), reason, kind, favId: folder.id })
    writeJsonAtomic(dataPath(ctx.dataDir, 'favorites.json'), { items })
    recordWrite(ctx, { type: 'fav', target: `BV:${opt.bvid}`, note: reason, auto: true, share: false })
    return { status: 'sent' }
  })
}

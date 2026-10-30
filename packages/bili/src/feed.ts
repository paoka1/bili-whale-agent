// 选题器：照她自己的偏好挑今天该看什么。只读，不产生任何对外动作。移植自 upstream/tools/commands/feed.mjs。
import fs from 'node:fs'
import { biliGet, isFatalBiliError } from './api.js'
import type { BiliContext } from './context.js'
import { dataPath } from './paths.js'
import { searchVideos, stripTags, durationOf, type VideoCard } from './search.js'
import { readJson, writeJsonAtomic } from './store.js'

export type FeedCandidate = VideoCard & { hits: string[]; source: string }

// 2026-10-22（上游）：搜索词要用切出来的短词，不能拿「鬼畜与怀旧向剪辑」整句去搜。
//   有分段就取第一段；整句切不开的（如「B站生态八卦」）取最后一个中文双字。
const JOIN_WORDS = /[\s·,，、/]+|与|和|及|向|的|类/
const partsOf = (p: string) => [...new Set(p.split(JOIN_WORDS).map((x) => x.trim()).filter((x) => x.length >= 2))]
const HAN2 = /^[一-龥]{2}$/

export function searchKeywordOf(p: string): string {
  const parts = partsOf(p)
  if (parts.length > 1) return parts[0]!
  if (parts.length === 1 && parts[0]!.length < 4) return parts[0]!
  const grams: string[] = []
  for (let i = 0; i + 2 <= p.length; i += 1) if (HAN2.test(p.slice(i, i + 2))) grams.push(p.slice(i, i + 2))
  return grams.at(-1) ?? p
}

/** 命中判断用的词：整句 + 切出的段 + 长段（≥4 字）的纯中文双字窗。双字窗只用于命中，不用于搜索。 */
export function tokensOf(p: string): string[] {
  const parts = partsOf(p)
  const extra: string[] = []
  for (const part of parts) {
    if (part.length < 4) continue
    for (let i = 0; i + 2 <= part.length; i += 1) if (HAN2.test(part.slice(i, i + 2))) extra.push(part.slice(i, i + 2))
  }
  return [...new Set([p, ...parts, ...extra])]
}

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/g
const SEARCH_TTL_MS = 10 * 60 * 1000

/** 看过 / 评论过 / 收藏过的 BV。评论账本读不了时抛错 —— 宁可不选题，也不重复分享。 */
function seenBVs(ctx: BiliContext): Set<string> {
  const seen = new Set<string>()
  for (const name of ['whale-diary.md', 'whale-diary-private.md']) {
    try { for (const m of fs.readFileSync(dataPath(ctx.dataDir, name), 'utf8').matchAll(BV_RE)) seen.add(m[0]) } catch { /* 还没写日记 */ }
  }
  let ledger: { log?: { type?: string; target?: string | null }[] } = {}
  try { ledger = JSON.parse(fs.readFileSync(dataPath(ctx.dataDir, 'quota.json'), 'utf8')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('评论账本无法读取，停止选题以免重复分享')
  }
  // 私信分享同样记成 BV:…（普通私信是 dm:…，正则会挡掉）
  for (const row of ledger.log ?? []) if ((row.type === 'comment' || row.type === 'dm') && /^BV:BV[0-9A-Za-z]{10}$/.test(row.target ?? '')) seen.add(row.target!.slice(3))
  for (const x of favItems(ctx)) seen.add(x.bvid)
  return seen
}

const favItems = (ctx: BiliContext) => (readJson<{ items?: { bvid?: string; title?: string; reason?: string }[] }>(dataPath(ctx.dataDir, 'favorites.json'), {}).items ?? [])
  .filter((x): x is { bvid: string; title?: string; reason?: string } => typeof x?.bvid === 'string')

// 2026-10-23（上游）：搜索结果按「关键词|排序」缓存 10 分钟，一晚跑两次 feed 不必再打一遍
async function searchCached(ctx: BiliContext, kw: string, order: 'click' | 'pubdate'): Promise<VideoCard[]> {
  const file = dataPath(ctx.dataDir, 'feed-search-cache.json')
  const key = `${kw}|${order}`
  const hit = readJson<Record<string, { at: number; data: VideoCard[] }>>(file, {})[key]
  if (hit && ctx.now() - hit.at < SEARCH_TTL_MS) return hit.data
  const data = await searchVideos(ctx, kw, { order })
  const store = readJson<Record<string, { at: number; data: VideoCard[] }>>(file, {})
  store[key] = { at: ctx.now(), data }
  const keys = Object.keys(store).sort((a, b) => store[a]!.at - store[b]!.at)
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete store[k]
  writeJsonAtomic(file, store)
  return data
}

type ListItem = { bvid?: string; title?: string; duration?: number; stat?: { danmaku?: number; view?: number }; owner?: { name?: string; mid?: number | string }; pubdate?: number }
const fromList = (it: ListItem): VideoCard => ({
  bvid: String(it.bvid), title: stripTags(it.title), author: String(it.owner?.name ?? ''), mid: String(it.owner?.mid ?? ''),
  play: Number(it.stat?.view ?? 0), danmaku: Number(it.stat?.danmaku ?? 0), durationSec: Number(it.duration ?? 0), pubdate: Number(it.pubdate ?? 0),
})

// 2026-10-18（上游）：只搜关键词等于只刷「搜索」，不像人 —— 再加热门、排行、关注三路
async function extraSources(ctx: BiliContext): Promise<(VideoCard & { source: string })[]> {
  const out: (VideoCard & { source: string })[] = []
  const popular = await biliGet<{ list?: ListItem[] }>(ctx, 'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20')
  for (const it of popular.data?.list ?? []) if (it.bvid) out.push({ ...fromList(it), source: '热门' })
  const rank = await biliGet<{ list?: ListItem[] }>(ctx, 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all')
  for (const it of (rank.data?.list ?? []).slice(0, 20)) if (it.bvid) out.push({ ...fromList(it), source: '排行' })
  type Dyn = { modules?: { module_author?: { name?: string; mid?: number }; module_dynamic?: { major?: { archive?: { bvid?: string; title?: string; duration_text?: string; stat?: { play?: number | string } } } } } }
  const following = await biliGet<{ items?: Dyn[] }>(ctx, 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video&page=1')
  for (const it of following.data?.items ?? []) {
    const ar = it.modules?.module_dynamic?.major?.archive
    if (!ar?.bvid) continue
    const a = it.modules?.module_author
    out.push({ bvid: ar.bvid, title: stripTags(ar.title), author: String(a?.name ?? ''), mid: String(a?.mid ?? ''), play: Number(ar.stat?.play ?? 0) || 0, danmaku: 0, durationSec: durationOf(ar.duration_text), pubdate: 0, source: '关注' })
  }
  return out
}

// 反馈回流：她收藏过的视频标题 + 理由里抽主题词（拉丁词 + 中文 3–4 字），候选标题命中就加分
const STOP_WORDS = new Set(['我为', '添加', '开屏', '广告', '这个', '那个', '什么', '自己', '可以', '就是', '一个'])
function learnTokens(text: string, ownerName: string): string[] {
  const out = new Set<string>()
  const t = (ownerName ? text.split(ownerName).join(' ') : text).replace(/@\S+/g, ' ')
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]+/g)) out.add(m[0].toLowerCase())
  for (const m of t.matchAll(/[一-龥]{2,}/g)) {
    for (const n of [3, 4]) for (let i = 0; i + n <= m[0].length; i += 1) { const g = m[0].slice(i, i + n); if (!STOP_WORDS.has(g)) out.add(g) }
  }
  return [...out]
}

/**
 * 候选：前 6 个偏好各搜一次（按词交替 click / pubdate），加上热门、排行、关注；
 * 排除看过 / 评论过 / 收藏过的、她自己的视频、几乎没人看的碎屑；
 * 按 log 弹幕密度 ×3 + 偏好命中 ×4 + 收藏回流（每词 2.5，封顶 7.5）排序。播放量不参与排序（上游 2026-10-20 主人定）。
 */
export async function feed(ctx: BiliContext, opt: { n?: number; pool?: number } = {}): Promise<{ prefs: string[]; candidates: FeedCandidate[] }> {
  const n = opt.n ?? 6
  const poolSize = opt.pool ?? 60
  const per = 2
  const prefs = [...ctx.settings.preferences.like]
  const seen = seenBVs(ctx)

  // 2026-10-23（上游）：6 个词 × 2 种排序 = 12 次太慢，改成每个词只搜一种排序
  const keywords = [...new Set(prefs.slice(0, 6).map(searchKeywordOf))]
  const perKw = Math.ceil(poolSize / Math.max(1, keywords.length)) + 4
  const pool: (VideoCard & { source: string })[] = []
  for (const [i, kw] of keywords.entries()) {
    try {
      for (const it of (await searchCached(ctx, kw, i % 2 === 0 ? 'click' : 'pubdate')).slice(0, perKw)) pool.push({ ...it, source: kw })
    } catch (e) {
      if (isFatalBiliError(e)) throw e // 这个词搜不到就跳过；风控、登录失效照常往上抛
    }
  }
  pool.push(...(await extraSources(ctx)))

  const prefTokens = prefs.map((label) => ({ label, tokens: tokensOf(label) }))
  const hitsOf = (title: string) => prefTokens.filter((p) => p.tokens.some((tok) => title.includes(tok))).map((p) => p.label)
  const ownerName = ctx.settings.owner.name
  const learned = [...new Set(favItems(ctx).flatMap((x) => learnTokens(`${x.title ?? ''} ${x.reason ?? ''}`, ownerName)))]
  const boostOf = (title: string) => Math.min(7.5, learned.filter((tok) => title.toLowerCase().includes(tok)).length * 2.5)
  const densityOf = (x: VideoCard) => Math.log10(1 + x.danmaku / Math.max(30, x.durationSec))
  const selfName = ctx.settings.self.name
  // 2026-10-22（上游）：丢掉几乎无人看过的碎屑（播放 <300 且弹幕 <3），但命中 ≥2 个偏好的留着
  const looksLikeJunk = (x: VideoCard) => x.play < 300 && x.danmaku < 3

  const scored = [...new Map(pool.map((x) => [x.bvid, x])).values()]
    .filter((x) => !seen.has(x.bvid))
    .filter((x) => !(selfName && x.author.includes(selfName)))
    .map((x) => { const hits = hitsOf(x.title); return { ...x, hits, score: densityOf(x) * 3 + hits.length * 4 + boostOf(x.title) } })
    .filter((x) => !looksLikeJunk(x) || x.hits.length >= 2)
    .sort((a, b) => b.score - a.score)

  // 多样性：同一「命中组合」最多 2 条，完全没命中偏好的最多 3 条
  const used = new Map<string, number>()
  const candidates: FeedCandidate[] = []
  for (const { score: _score, ...x } of scored) {
    if (candidates.length >= n) break
    const key = x.hits.length ? x.hits.join('+') : ''
    if ((used.get(key) ?? 0) >= (x.hits.length ? per : 3)) continue
    used.set(key, (used.get(key) ?? 0) + 1)
    candidates.push(x)
  }
  return { prefs, candidates }
}

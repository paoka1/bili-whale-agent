import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { feed, searchKeywordOf, tokensOf } from '../src/feed.js'
import { defaultSettings } from '../src/context.js'
import { fakeBili, json } from './helpers.js'

// 数值来自 2026-10-29 用上游代码实测
it.each([
  ['哈基米/哈基米音乐', '哈基米'], ['明日方舟/终末地', '明日方舟'], ['魔法Zc目录/魔法Zc', '魔法Zc目录'],
  ['血狼破军/血狼', '血狼破军'], ['龙哥哥今天又鸽了/龙哥哥', '龙哥哥今天又鸽了'], ['vlog', 'vlog'],
  ['DSH/AI 工具与插件', 'DSH'], ['明日方舟', '方舟'], ['魔法Zc目录', '目录'],
])('searchKeywordOf(%s) = %s', (p, k) => expect(searchKeywordOf(p)).toBe(k))

it('tokensOf 给长段补双字窗', () => expect(tokensOf('明日方舟/终末地')).toEqual(['明日方舟/终末地', '明日方舟', '终末地', '明日', '日方', '方舟']))

const PREFS = ['鬼畜', '猫咪', '音乐', '游戏', '科技', '美食', '旅行']
const SEEN = 'BV1xxxxxxxxx', COMMENTED = 'BV1yyyyyyyyy', FAVED = 'BV1zzzzzzzzz', SELF = 'BV1sssssssss', JUNK = 'BV1jjjjjjjjj', DM_SHARED = 'BV1ddddddddd'
const card = (bvid: string, title: string, over: Record<string, unknown> = {}) => ({ bvid, title, author: 'UP', mid: 1, play: 5000, danmaku: 80, duration: '3:00', pubdate: 1, ...over })

function setup() {
  const settings = defaultSettings()
  settings.preferences.like = PREFS
  settings.self = { mid: '7', name: '小鲸' }
  const env = fakeBili((url) => {
    if (url.pathname === '/x/web-interface/wbi/search/type') {
      const kw = url.searchParams.get('keyword')!
      const i = PREFS.indexOf(kw)
      const list = [card(`BV1${String(i).padStart(9, '0')}`, `<em>${kw}</em>合集`)]
      // 每条被排除的视频命中不同偏好，免得被「同类最多 2 条」顺手挡掉而掩盖排除逻辑的问题
      if (i === 0) list.push(card(SEEN, '猫咪旧片'), card(COMMENTED, '音乐评论过'), card(FAVED, '游戏收藏过'), card(SELF, '科技自己', { author: '小鲸' }), card(JUNK, '没人看', { play: 10, danmaku: 0 }), card(DM_SHARED, '美食私信分享过'))
      return json({ code: 0, data: { result: list } })
    }
    if (url.pathname === '/x/web-interface/popular') return json({ code: 0, data: { list: [{ bvid: 'BV1ppppppppp', title: '热门视频', duration: 60, stat: { danmaku: 5, view: 9000 }, owner: { name: 'P' } }] } })
  }, { settings })
  fs.writeFileSync(path.join(env.dataDir, 'whale-diary.md'), `# 日记\n看了 ${SEEN}，还行。\n`)
  fs.writeFileSync(path.join(env.dataDir, 'quota.json'), JSON.stringify({ log: [{ type: 'comment', target: `BV:${COMMENTED}` }, { type: 'dm', target: `BV:${DM_SHARED}` }, { type: 'dm', target: 'dm:222' }] }))
  fs.writeFileSync(path.join(env.dataDir, 'favorites.json'), JSON.stringify({ items: [{ bvid: FAVED, title: '收藏', reason: '好' }] }))
  return env
}
const searches = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname === '/x/web-interface/wbi/search/type').map((c) => [c.url.searchParams.get('keyword'), c.url.searchParams.get('order')])

it('feed 只用前 6 个偏好搜索，并排除已看过的 BV', async () => {
  const { ctx, calls } = setup()
  const r = await feed(ctx, { n: 10 })
  expect(r.prefs).toEqual(PREFS)
  const searched = searches(calls)
  expect(searched).toHaveLength(6)
  expect(searched).toEqual(PREFS.slice(0, 6).map((kw, i) => [kw, i % 2 === 0 ? 'click' : 'pubdate']))
  const ids = r.candidates.map((c) => c.bvid)
  for (const bad of [SEEN, COMMENTED, FAVED, SELF, JUNK, DM_SHARED]) expect(ids).not.toContain(bad)
  expect(ids).toContain('BV1ppppppppp')
  expect(r.candidates[0]!.hits).toHaveLength(1)
  expect(r.candidates[0]!.title).not.toContain('<em>')
  expect(r.candidates.find((c) => c.bvid === 'BV1ppppppppp')!.source).toBe('热门')
})

it('feed 的搜索结果缓存 10 分钟，n 限制条数', async () => {
  const { ctx, calls } = setup()
  await feed(ctx)
  const r = await feed(ctx, { n: 3 })
  expect(searches(calls)).toHaveLength(6)
  expect(r.candidates).toHaveLength(3)
})

it('评论账本读不了时停止选题，免得重复分享', async () => {
  const { ctx, dataDir } = setup()
  fs.writeFileSync(path.join(dataDir, 'quota.json'), '{坏掉的')
  await expect(feed(ctx)).rejects.toThrow(/账本/)
})

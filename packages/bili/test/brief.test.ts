import { expect, it } from 'vitest'
import { briefVideo } from '../src/brief.js'
import { LoginExpiredError } from '../src/api.js'
import { fakeBili, json, viewData } from './helpers.js'

function route(over: { reply?: () => Response } = {}) {
  return (url: URL) => {
    if (url.pathname === '/x/web-interface/wbi/view') return json({ code: 0, data: viewData() })
    if (url.pathname === '/x/player/wbi/v2') return json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/z.json' }] } } })
    if (url.hostname === 'aisubtitle.hdslb.com') return json({ body: Array.from({ length: 400 }, (_, i) => ({ from: i * 2, to: i * 2 + 2, content: `第${i}句字幕内容比较长一些` })) })
    if (url.hostname === 'comment.bilibili.com') return new Response(`<i><d p="61,1">名场面</d><d p="62,1">名场面</d></i>`)
    if (url.pathname === '/x/v2/reply') return over.reply?.() ?? json({ code: 0, data: { replies: [{ rpid: 1, member: { uname: 'a', mid: 1 }, content: { message: '好看' } }] } })
  }
}

it('briefVideo 组合四路且字幕截断到 6000 字', async () => {
  const { ctx, calls } = fakeBili(route())
  const b = await briefVideo(ctx, 'BV1AAAAAAAAA', { comments: 5 })
  expect(b.meta.title).toBe('测试视频')
  expect(b.subtitles!.length).toBeLessThanOrEqual(6000)
  expect(b.subtitles!.startsWith('[00:00] 第0句')).toBe(true)
  expect(b.subtitles!.endsWith('…')).toBe(true)
  expect(b.danmaku.hotspots[0]).toMatchObject({ t: 60, count: 2, line: '第37句字幕内容比较长一些' }) // 对齐到桶中点 75 秒
  expect(b.comments.map((c) => c.text)).toEqual(['好看'])
  expect(calls.find((c) => c.url.pathname === '/x/v2/reply')!.url.searchParams.get('ps')).toBe('5')
  // 元信息只请求一次（后续走缓存）
  expect(calls.filter((c) => c.url.pathname === '/x/web-interface/wbi/view')).toHaveLength(1)
})

it('某一路失败不影响其他路，但登录失效要往上抛', async () => {
  const { ctx } = fakeBili(route({ reply: () => json({ code: 12002, message: '评论区已关闭' }) }))
  expect((await briefVideo(ctx, 'BV1AAAAAAAAA')).comments).toEqual([])
  const expired = fakeBili(route({ reply: () => json({ code: -101, message: '账号未登录' }) }))
  await expect(briefVideo(expired.ctx, 'BV1AAAAAAAAA')).rejects.toBeInstanceOf(LoginExpiredError)
})

import zlib from 'node:zlib'
import { expect, it } from 'vitest'
import { getSubtitles } from '../src/subtitles.js'
import { getDanmakuHotspots } from '../src/danmaku.js'
import { fakeBili, json, viewData } from './helpers.js'

const view = (url: URL) => url.pathname.endsWith('/view') && url.pathname.startsWith('/x/web-interface') ? json({ code: 0, data: viewData() }) : undefined

it('字幕接口回 HTML 时当作没有字幕', async () => {
  const { ctx } = fakeBili((url) => view(url)
    ?? (url.pathname === '/x/player/wbi/v2' ? json({ code: 0, data: { subtitle: { subtitles: [] } } }) : undefined)
    ?? (url.pathname === '/x/v2/subtitle/web/view' ? new Response('<html>出错了</html>') : undefined))
  expect(await getSubtitles(ctx, 'BV1AAAAAAAAA')).toBeNull()
})

it('优先 ai-zh 轨道，下载字幕不带 cookie', async () => {
  const { ctx, calls } = fakeBili((url) => view(url)
    ?? (url.pathname === '/x/player/wbi/v2' ? json({ code: 0, data: { subtitle: { subtitles: [
      { lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/bfs/en.json?auth_key=1' },
      { lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/zh.json?auth_key=2-0-abc' },
    ] } } }) : undefined)
    ?? (url.hostname === 'aisubtitle.hdslb.com' ? json({ body: [{ from: 1.5, to: 3, content: '你好' }, { from: 4, to: 5, content: '再见' }] }) : undefined))
  expect(await getSubtitles(ctx, 'BV1AAAAAAAAA')).toEqual({ lang: 'ai-zh', lines: [{ t: 1.5, text: '你好' }, { t: 4, text: '再见' }] })
  const player = calls.find((c) => c.url.pathname === '/x/player/wbi/v2')!
  expect(player.url.searchParams.get('cid')).toBe('202')
  expect(player.url.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/)
  const cdn = calls.find((c) => c.url.hostname === 'aisubtitle.hdslb.com')!
  expect(cdn.url.searchParams.get('auth_key')).toBe('2-0-abc')
  expect(new Headers(cdn.init.headers).get('cookie')).toBeNull()
})

it('主端点没有字幕时走兜底端点', async () => {
  const { ctx } = fakeBili((url) => view(url)
    ?? (url.pathname === '/x/player/wbi/v2' ? json({ code: 0, data: { subtitle: { subtitles: [] } } }) : undefined)
    ?? (url.pathname === '/x/v2/subtitle/web/view' ? json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/z.json' }] } } }) : undefined)
    ?? (url.hostname === 'aisubtitle.hdslb.com' ? json({ body: [{ from: 0, content: '兜底' }] }) : undefined))
  expect((await getSubtitles(ctx, 'BV1AAAAAAAAA'))?.lines[0]?.text).toBe('兜底')
})

it('弹幕：解开无头 deflate，剔除刷屏与纯符号，按有效条数排热区', async () => {
  const d = (t: number, text: string) => `<d p="${t},1,25,16777215,0,0,0,0">${text}</d>`
  const xml = `<?xml version="1.0"?><i>${[
    ...Array.from({ length: 30 }, (_, i) => d(i % 10, '哈哈哈哈')),
    ...Array.from({ length: 25 }, (_, i) => d(i % 10, '？？？')),
    ...Array.from({ length: 5 }, () => d(65, '名场面')),
    d(70, '好家伙 &amp; 对'),
  ].join('')}</i>`
  const { ctx, calls } = fakeBili((url) => view(url) ?? (url.hostname === 'comment.bilibili.com' ? new Response(zlib.deflateRawSync(Buffer.from(xml))) : undefined))
  const r = await getDanmakuHotspots(ctx, 'BV1AAAAAAAAA', { bucketSec: 30, subtitleLines: [{ t: 64, text: '这里是高潮' }] })
  expect(r.total).toBe(61)
  expect(r.effective).toBe(6)
  expect(r.hotspots).toEqual([{ t: 60, count: 6, samples: ['名场面×5', '好家伙 & 对'], line: '这里是高潮' }])
  expect(calls.find((c) => c.url.hostname === 'comment.bilibili.com')!.url.pathname).toBe('/202.xml')
})

it('弹幕取不到时返回空结果', async () => {
  const { ctx } = fakeBili((url) => view(url) ?? (url.hostname === 'comment.bilibili.com' ? new Response('', { status: 500 }) : undefined))
  expect(await getDanmakuHotspots(ctx, 'BV1AAAAAAAAA')).toEqual({ total: 0, effective: 0, hotspots: [] })
})

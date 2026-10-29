import { expect, it } from 'vitest'
import { getVideo } from '../src/video.js'
import { getComments } from '../src/comments.js'
import { searchVideos } from '../src/search.js'
import { fakeBili, json, viewData } from './helpers.js'

it('getVideo 整理元信息与标签', async () => {
  const { ctx } = fakeBili((url) => {
    if (url.pathname.endsWith('/view')) return json({ code: 0, data: viewData() })
    if (url.pathname === '/x/tag/archive/tags') return json({ code: 0, data: [{ tag_name: '猫' }, { tag_name: '日常' }] })
  })
  const v = await getVideo(ctx, 'BV1AAAAAAAAA')
  expect(v).toEqual({
    bvid: 'BV1AAAAAAAAA', aid: 101, cid: 202, title: '测试视频', desc: '简介', owner: { mid: '9', name: 'UP主' }, durationSec: 125, pubdate: 1761700000,
    stat: { view: 1000, danmaku: 50, like: 30, favorite: 20, reply: 10 }, tags: ['猫', '日常'], coverUrl: 'https://i0.hdslb.com/bfs/archive/c.jpg',
  })
})

it('getVideo：标签取不到不影响，视频不存在时报错', async () => {
  const { ctx } = fakeBili((url) => {
    if (url.pathname.endsWith('/view')) return url.searchParams.get('bvid') === 'BV1AAAAAAAAA' ? json({ code: 0, data: viewData() }) : json({ code: -404, message: '啥都木有' })
  })
  expect((await getVideo(ctx, 'BV1AAAAAAAAA')).tags).toEqual([])
  await expect(getVideo(ctx, 'BV1BBBBBBBBB')).rejects.toThrow(/视频信息获取失败.*-404/)
})

it('getComments：置顶在前，正文压缩空白并截断，sort=time 用时间序', async () => {
  const reply = (rpid: number, message: string) => ({ rpid, member: { uname: `u${rpid}`, mid: rpid * 10 }, like: rpid, rcount: 1, ctime: 1761700000, content: { message } })
  const { ctx, calls } = fakeBili((url) => {
    if (url.pathname.endsWith('/view')) return json({ code: 0, data: viewData() })
    if (url.pathname === '/x/v2/reply') return json({ code: 0, data: { upper: { top: reply(1, '置顶') }, replies: [reply(2, '第一行\n\n第二行'), reply(3, '长'.repeat(500))] } })
  })
  const items = await getComments(ctx, 'BV1AAAAAAAAA', { sort: 'time', maxChars: 50 })
  expect(items.map((c) => c.rpid)).toEqual(['1', '2', '3'])
  expect(items[0]).toMatchObject({ tag: 'UP置顶', uname: 'u1', mid: '10' })
  expect(items[1]!.text).toBe('第一行 第二行')
  expect(items[2]!.text).toHaveLength(50)
  const req = calls.find((c) => c.url.pathname === '/x/v2/reply')!
  expect(req.url.searchParams.get('oid')).toBe('101')
  expect(req.url.searchParams.get('sort')).toBe('0')
})

it('searchVideos：签名请求、去掉 <em>、时长换成秒，接口失败时报错', async () => {
  let fail = false
  const { ctx, calls } = fakeBili((url) => {
    if (url.pathname === '/x/web-interface/wbi/search/type') {
      if (fail) return json({ code: -400, message: '请求错误' })
      return json({ code: 0, data: { result: [{ bvid: 'BV1CCCCCCCCC', title: '<em class="keyword">猫</em>咪', author: 'A', mid: 5, play: 10, danmaku: 2, duration: '1:02:03', pubdate: 1 }] } })
    }
  })
  const list = await searchVideos(ctx, '猫', { order: 'pubdate' })
  expect(list).toEqual([{ bvid: 'BV1CCCCCCCCC', title: '猫咪', author: 'A', mid: '5', play: 10, danmaku: 2, durationSec: 3723, pubdate: 1 }])
  const req = calls.find((c) => c.url.pathname.includes('search'))!
  expect(req.url.searchParams.get('keyword')).toBe('猫')
  expect(req.url.searchParams.get('order')).toBe('pubdate')
  expect(req.url.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/)
  fail = true
  await expect(searchVideos(ctx, '狗')).rejects.toThrow(/搜索失败.*-400/)
})

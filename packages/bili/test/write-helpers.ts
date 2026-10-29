// 写能力的假 B 站：POST 后可回读正文和署名，始终不访问真实网络。
import { fakeBili, json, navOk, viewData } from './helpers.js'

export const BV = 'BV1AAAAAAAAA'
export const share = { reason: '这段讲解清楚值得再看', score: 15, rank: 1 }
export const draftInput = { bvid: BV, oid: '101', root: '9', parent: '9', who: '访客', src: '原评论', message: '谢谢你的建议' }

export function fakeWrites(opt: { parentMid?: string; handler?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined } = {}) {
  const posted = new Map<string, { rpid_str: string; mid: string; content: { message: string }; root: string }>()
  let next = 1000
  const s = fakeBili(async (url, init) => {
    const overridden = await opt.handler?.(url, init)
    if (overridden) return overridden
    if (url.pathname.endsWith('/nav')) return json({ ...navOk, data: { ...navOk.data, mid: 111, uname: '小号' } })
    if (url.pathname === '/x/web-interface/wbi/view') return json({ code: 0, data: viewData({ bvid: url.searchParams.get('bvid') }) })
    if (url.pathname === '/x/tag/archive/tags') return json({ code: 0, data: [] })
    if (url.pathname === '/x/v2/reply/add') {
      const form = new URLSearchParams(String(init.body))
      const rpid = String(next++)
      posted.set(rpid, { rpid_str: rpid, mid: '111', content: { message: form.get('message')! }, root: form.get('root') ?? rpid })
      return json({ code: 0, data: { rpid_str: rpid } })
    }
    if (url.pathname === '/x/v2/reply/reply') {
      const root = url.searchParams.get('root')!
      return json({ code: 0, data: {
        root: posted.get(root) ?? { rpid_str: root, member: { mid: opt.parentMid ?? '333' }, content: { message: '原评论' } },
        replies: [...posted.values()].filter((r) => r.root === root && r.rpid_str !== root),
      } })
    }
    if (url.pathname === '/x/relation') return json({ code: 0, data: { attribute: 6 } })
    if (url.pathname === '/x/v3/fav/folder/created/list-all') return json({ code: 0, data: { list: [{ id: 10, title: '其他' }, { id: 11, title: '默认收藏夹' }] } })
    if (url.pathname === '/x/v3/fav/resource/deal' || url.pathname.endsWith('/send_msg')) return json({ code: 0, data: {} })
  }, { dryRun: false })
  s.ctx.settings.owner = { mid: '222', name: '主人' }
  s.ctx.settings.self = { mid: '111', name: '小号' }
  return { ...s, posted, writes: () => s.calls.filter((c) => c.init.method === 'POST') }
}

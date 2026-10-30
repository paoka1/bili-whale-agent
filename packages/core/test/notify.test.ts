import { afterEach, expect, it, vi } from 'vitest'
import * as bili from '@bili-whale/bili'
import { ConfigSchema } from '../src/config.js'
import { notify } from '../src/notify.js'
import { fakeBili } from '../../bili/test/helpers.js'

vi.mock('@bili-whale/bili', async (original) => ({ ...await original<typeof import('@bili-whale/bili')>(), dmOwner: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const msg = { title: '通知', text: '今晚看到了猫' }

it('none 不发送网络请求', async () => {
  const s = fakeBili(() => undefined), fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  expect(await notify(ConfigSchema.parse({}), s.ctx, msg)).toEqual({ ok: true })
  expect(fetcher).not.toHaveBeenCalled()
  expect(bili.dmOwner).not.toHaveBeenCalled()
})

it('私信走 dmOwner，保留演练模式及闸门拒绝结果', async () => {
  const s = fakeBili(() => undefined), cfg = ConfigSchema.parse({ notify: { type: 'dm' } })
  vi.mocked(bili.dmOwner).mockResolvedValueOnce({ status: 'dry-run' }).mockResolvedValueOnce({ status: 'refused', reason: '双方需要互关' })
  expect(await notify(cfg, s.ctx, msg)).toEqual({ ok: true })
  expect(bili.dmOwner).toHaveBeenCalledWith(s.ctx, { message: '通知\n今晚看到了猫' })
  expect(await notify(cfg, s.ctx, msg)).toEqual({ ok: false, error: '双方需要互关' })
})

it('私信推送超过 300 字时截断并提示看网页，免得被 dmOwner 整条拒绝', async () => {
  const s = fakeBili(() => undefined), cfg = ConfigSchema.parse({ notify: { type: 'dm' } })
  vi.mocked(bili.dmOwner).mockResolvedValue({ status: 'sent' })
  expect(await notify(cfg, s.ctx, { title: '她醒来过一次', text: '信'.repeat(1000) })).toEqual({ ok: true })
  const { message } = vi.mocked(bili.dmOwner).mock.calls[0]![1]
  expect(message.length).toBeLessThanOrEqual(300)
  expect(message.startsWith('她醒来过一次\n信')).toBe(true)
  expect(message.endsWith('…（全文见网页活动页）')).toBe(true)
})

it('写给主人的信私信时只发正文，不加标题', async () => {
  const s = fakeBili(() => undefined), cfg = ConfigSchema.parse({ notify: { type: 'dm' } })
  vi.mocked(bili.dmOwner).mockResolvedValue({ status: 'sent' })
  await notify(cfg, s.ctx, { title: '她醒来过一次', text: '晚上好，今天看到一只猫。', letter: true })
  expect(bili.dmOwner).toHaveBeenCalledWith(s.ctx, { message: '晚上好，今天看到一只猫。' })
})

it.each([
  ['https://example.com/hook', msg],
  ['https://open.feishu.cn/open-apis/bot/v2/hook/secret', { msg_type: 'text', content: { text: '通知\n今晚看到了猫' } }],
  ['https://oapi.dingtalk.com/robot/send', { msgtype: 'text', text: { content: '通知\n今晚看到了猫' } }],
  ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send', { msgtype: 'text', text: { content: '通知\n今晚看到了猫' } }],
])('webhook 按域名生成报文：%s', async (url, body) => {
  const s = fakeBili(() => undefined), fetcher = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  expect(await notify(ConfigSchema.parse({ notify: { type: 'webhook', url } }), s.ctx, msg)).toEqual({ ok: true })
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', body: JSON.stringify(body), redirect: 'error' }))
})

it('webhook 十秒超时，错误不带地址或凭据', async () => {
  vi.useFakeTimers()
  const s = fakeBili(() => undefined)
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('secret-url SESS-SECRET')), { once: true })
  })))
  const result = notify(ConfigSchema.parse({ notify: { type: 'webhook', url: 'https://example.com/secret-url' } }), s.ctx, msg)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await result).toEqual({ ok: false, error: 'Webhook 推送超时' })
})

it('webhook HTTP 失败不回显响应正文', async () => {
  const s = fakeBili(() => undefined)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('secret', { status: 500 })))
  expect(await notify(ConfigSchema.parse({ notify: { type: 'webhook', url: 'https://example.com/hook' } }), s.ctx, msg)).toEqual({ ok: false, error: 'Webhook 推送失败（HTTP 500）' })
})

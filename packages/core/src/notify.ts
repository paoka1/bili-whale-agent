// 推送只使用配置中的通道；Webhook 是 B 站域名白名单的唯一例外，不暴露给 agent。
import { dmOwner, type BiliContext } from '@bili-whale/bili'
import type { AppConfig } from './config.js'

export type Notification = { title: string; text: string }
export type NotifyResult = { ok: boolean; error?: string }

function webhookBody(url: string, msg: Notification): object {
  const host = new URL(url).hostname
  const matches = (domain: string) => host === domain || host.endsWith('.' + domain)
  const line = `${msg.title}\n${msg.text}`
  // 移植上游 notify.mjs 的文本报文适配；只匹配真实域名，不匹配路径或查询参数。
  if (matches('open.feishu.cn') || matches('larksuite.com')) return { msg_type: 'text', content: { text: line } }
  if (matches('oapi.dingtalk.com') || matches('qyapi.weixin.qq.com')) return { msgtype: 'text', text: { content: line } }
  return msg
}

export async function notify(cfg: AppConfig, ctx: BiliContext, msg: Notification): Promise<NotifyResult> {
  if (cfg.notify.type === 'none') return { ok: true }
  if (cfg.notify.type === 'dm') {
    try {
      // dmOwner 负责互关、额度与演练模式，不绕过任何写闸门。
      const result = await dmOwner(ctx, { message: `${msg.title}\n${msg.text}` })
      return result.status === 'refused' ? { ok: false, error: result.reason ?? '私信推送被拒绝' } : { ok: true }
    } catch { return { ok: false, error: '私信推送未完成，请检查登录与请求保护状态' } }
  }
  if (!cfg.notify.url) return { ok: false, error: '请先配置 Webhook 地址' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const result = await fetch(cfg.notify.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookBody(cfg.notify.url, msg)),
      signal: controller.signal, redirect: 'error',
    })
    // 不回显响应正文或异常里的 URL，避免泄露 Webhook token 与凭据。
    await result.body?.cancel()
    return result.ok ? { ok: true } : { ok: false, error: `Webhook 推送失败（HTTP ${result.status}）` }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'Webhook 推送超时' : 'Webhook 推送未完成，请检查配置与网络' }
  } finally { clearTimeout(timer) }
}

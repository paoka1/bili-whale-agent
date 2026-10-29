// 短期扫码登录状态机。移植自 upstream/lib/auth.js，不向调用方返回 cookie、key 或 refresh token。
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { parseJsonExact } from './api.js'
import { cookieHeader, type BiliCred } from './creds.js'
import { assertBiliUrl } from './net.js'
import { defaultTransport, type Transport } from './traffic.js'
import { isId, isObject } from './write.js'

export type QrState = { id: string; status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'; image?: string; account?: { mid: string; name: string }; error?: string; expiresAt: number }
export type QrLoginOptions = { save: (cred: BiliCred, account: { mid: string; name: string }) => Promise<void>; fetch?: typeof fetch; now?: () => number }
type Session = QrState & { controller: AbortController; key?: string; nextPoll: number; flight?: Promise<QrState>; saving?: boolean }
class QrLoginError extends Error {}
const PASSPORT = 'https://passport.bilibili.com'
const INTERVAL_MS = 2000
const TTL_MS = 180000
const terminal = (s: Session) => s.status === 'confirmed' || s.status === 'expired' || s.status === 'failed'

async function request(transport: Transport, url: URL, signal: AbortSignal, credentials?: BiliCred): Promise<{ data: unknown; response: Response }> {
  try {
    assertBiliUrl(url)
    const response = await transport(url, {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'user-agent': 'Mozilla/5.0', referer: PASSPORT + '/login', ...(credentials ? { cookie: cookieHeader(credentials) } : {}) },
    })
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error() }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 128 * 1024) throw new Error()
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const body = parseJsonExact(Buffer.concat(chunks).toString('utf8'))
    if (!isObject(body) || body.code !== 0) throw new Error()
    return { data: body.data, response }
  } catch {
    throw new QrLoginError(signal.aborted ? '登录已取消或失效，请重新扫码' : 'B 站登录请求失败，请稍后重试')
  }
}

function credentialsOf(headers: Headers): BiliCred {
  const values = new Map<string, string>()
  for (const cookie of headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0]!
    const split = pair.indexOf('=')
    if (split < 1) continue
    const key = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim()
    if (!['SESSDATA', 'bili_jct', 'buvid3'].includes(key)) continue
    if (values.has(key) && values.get(key) !== value) throw new QrLoginError('登录凭据冲突，请重新扫码')
    values.set(key, value)
  }
  const cred = { sessdata: values.get('SESSDATA') ?? '', bili_jct: values.get('bili_jct') ?? '', buvid3: values.get('buvid3') ?? '' }
  if (cred.sessdata.length < 20 || cred.sessdata.length > 8192 || !/^[0-9a-fA-F]{32}$/.test(cred.bili_jct)
    || Object.values(cred).some((value) => value.length > 8192 || /[\r\n;\x00-\x1f\x7f]/.test(value))) throw new QrLoginError('登录凭据不完整或格式无效，请重新扫码')
  return cred
}

export class QrLogin {
  private readonly transport: Transport
  private readonly now: () => number
  private current: Session | null = null
  private nextStart = 0

  constructor(private readonly opt: QrLoginOptions) {
    this.transport = opt.fetch ?? defaultTransport
    this.now = opt.now ?? Date.now
  }

  private state(s: Session): QrState {
    return { id: s.id, status: s.status, expiresAt: s.expiresAt,
      ...(!terminal(s) && s.image ? { image: s.image } : {}),
      ...(s.account ? { account: { ...s.account } } : {}), ...(s.error ? { error: s.error } : {}) }
  }

  private finish(s: Session, status: 'confirmed' | 'expired' | 'failed', error?: string): void {
    s.status = status
    if (error) s.error = error
    delete s.key
    delete s.image
    s.controller.abort()
  }

  private check(s: Session): void {
    if (this.current !== s || s.controller.signal.aborted) throw new QrLoginError('登录流程已取消或失效，请重新扫码')
    if (this.now() >= s.expiresAt) {
      this.finish(s, 'expired')
      throw new QrLoginError('二维码已过期，请重新生成')
    }
  }

  async start(): Promise<QrState> {
    if (this.current?.saving) throw new QrLoginError('登录正在保存，请稍后再生成二维码')
    if (this.now() < this.nextStart) throw new QrLoginError('请稍等两秒后再生成二维码')
    this.nextStart = this.now() + INTERVAL_MS
    this.cancel()
    const s: Session = { id: randomUUID(), status: 'waiting', controller: new AbortController(), expiresAt: this.now() + TTL_MS, nextPoll: this.now() + INTERVAL_MS }
    this.current = s
    try {
      const { data } = await request(this.transport, new URL('/x/passport-login/web/qrcode/generate', PASSPORT), s.controller.signal)
      this.check(s)
      if (!isObject(data) || typeof data.url !== 'string' || data.url.length > 8192
        || typeof data.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.qrcode_key)) throw new QrLoginError('二维码响应无效，请稍后重试')
      const url = new URL(data.url)
      if (![PASSPORT, 'https://account.bilibili.com'].includes(url.origin) || url.username || url.password) throw new QrLoginError('二维码响应无效，请稍后重试')
      s.key = data.qrcode_key
      s.image = await QRCode.toDataURL(url.href, { width: 220, margin: 2 })
      this.check(s)
      return this.state(s)
    } catch (e) {
      if (!terminal(s)) this.finish(s, 'failed', e instanceof QrLoginError ? e.message : '二维码生成失败，请重试')
      throw new QrLoginError(e instanceof QrLoginError ? e.message : '二维码生成失败，请重试')
    }
  }

  async poll(id: string): Promise<QrState> {
    const s = this.current
    if (!s || s.id !== id) throw new QrLoginError('登录流程已失效，请重新扫码')
    if (terminal(s)) return this.state(s)
    if (s.flight) return s.flight
    if (this.now() >= s.expiresAt) { this.finish(s, 'expired'); return this.state(s) }
    if (this.now() < s.nextPoll) return this.state(s)
    s.nextPoll = this.now() + INTERVAL_MS
    s.flight = this.pollOnce(s).finally(() => { delete s.flight })
    return s.flight
  }

  private async pollOnce(s: Session): Promise<QrState> {
    try {
      const url = new URL('/x/passport-login/web/qrcode/poll', PASSPORT)
      url.searchParams.set('qrcode_key', s.key!)
      const { data, response } = await request(this.transport, url, s.controller.signal)
      this.check(s)
      if (!isObject(data)) throw new QrLoginError('无法识别登录状态，请重新扫码')
      if (data.code === 86101) s.status = 'waiting'
      else if (data.code === 86090) s.status = 'scanned'
      else if (data.code === 86038) this.finish(s, 'expired')
      else if (data.code === 0) {
        const cred = credentialsOf(response.headers)
        const nav = await request(this.transport, new URL('https://api.bilibili.com/x/web-interface/nav'), s.controller.signal, cred)
        this.check(s)
        if (!isObject(nav.data) || nav.data.isLogin !== true || !['string', 'number'].includes(typeof nav.data.mid)
          || (typeof nav.data.mid === 'number' && !Number.isSafeInteger(nav.data.mid))
          || !isId(String(nav.data.mid ?? '')) || String(nav.data.mid).length > 20) throw new QrLoginError('登录验证失败，旧登录态未替换')
        let name = typeof nav.data.uname === 'string' ? nav.data.uname : ''
        for (const secret of [...Object.values(cred), s.key, data.refresh_token, data.url]) {
          if (typeof secret === 'string' && secret) name = name.split(secret).join('已打码')
        }
        const account = { mid: String(nav.data.mid), name: name.slice(0, 200) }
        // 保存是提交边界；从这里起等待原子保存完成，不允许新挑战或取消打断已经开始的持久化。
        s.saving = true
        try { await this.opt.save(cred, { ...account }) } finally { s.saving = false }
        s.account = account
        this.finish(s, 'confirmed')
      } else throw new QrLoginError('无法识别登录状态，请重新扫码')
    } catch (e) {
      if (!terminal(s)) this.finish(s, 'failed', e instanceof QrLoginError ? e.message : '登录未保存，请重新扫码')
    }
    return this.state(s)
  }

  cancel(id?: string): void {
    const s = this.current
    if (!s || (id !== undefined && s.id !== id) || terminal(s) || s.saving) return
    this.finish(s, 'failed', '登录已取消，请重新扫码')
  }
}

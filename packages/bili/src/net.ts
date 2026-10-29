/** 只允许访问这些域名（及其子域名）：B 站主站、接口、图片与视频 CDN。 */
export const ALLOWED_HOST_SUFFIXES = ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'biliapi.com', 'biliapi.net'] as const

export class NetDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetDeniedError'
  }
}

export function assertBiliUrl(input: string | URL): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new NetDeniedError('不允许的地址：无法解析')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NetDeniedError(`不允许的地址：协议 ${url.protocol}`)
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) throw new NetDeniedError(`不允许的地址：${host} 不是 B 站域名`)
  return url
}

export const isBiliApiHost = (url: URL): boolean => url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')

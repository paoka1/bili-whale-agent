// 移植自 upstream/tools/lib/cred.mjs
import { dataPath } from './paths.js'
import { readJson, writeJsonAtomic } from './store.js'

export type BiliCred = { sessdata: string; bili_jct: string; buvid3?: string }

const credFile = (dataDir: string) => dataPath(dataDir, 'credentials.json')
// 粘贴 cookie 时常带空格、换行、引号
const clean = (v: unknown) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')

/** 读凭据；没有文件或没有 SESSDATA 时返回 null。 */
export function loadCred(dataDir: string): BiliCred | null {
  const raw = readJson<Record<string, unknown> | null>(credFile(dataDir), null)
  if (!raw) return null
  const cred = { sessdata: clean(raw.sessdata), bili_jct: clean(raw.bili_jct), buvid3: clean(raw.buvid3) }
  return cred.sessdata ? cred : null
}

export function saveCred(dataDir: string, cred: BiliCred): void {
  writeJsonAtomic(credFile(dataDir), { sessdata: clean(cred.sessdata), bili_jct: clean(cred.bili_jct), buvid3: clean(cred.buvid3) }, 0o600)
}

export function cookieHeader(cred: BiliCred): string {
  const parts = [`SESSDATA=${cred.sessdata}`, `bili_jct=${cred.bili_jct}`]
  if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`)
  return parts.join('; ')
}

/** 常见返回码 → 人话 */
const CODE_HINTS: Record<string, string> = {
  '-101': '账号未登录，登录态失效了，请重新扫码',
  '-111': 'CSRF 校验失败，登录态不完整或已过期，请重新扫码',
  '-400': '请求参数错误',
  '-352': '风控拦截，请求太快或太像机器人，等几分钟再来',
  '-799': '请求过于频繁，退避一会儿',
  '10031': '操作太快（频率限制），别连发',
  '12015': '需要验证码，请在浏览器里手动处理一次',
  '12051': '疑似刷屏，停下别再发',
  '12002': '评论区已关闭，不能评论',
}

export function explainCode(code: number | string): string {
  const k = String(code)
  return CODE_HINTS[k] ? `code=${k} ${CODE_HINTS[k]}` : `code=${k}（未知返回码）`
}

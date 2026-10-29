// 写能力共用的本地状态、账号校验与互斥；这些辅助函数不暴露给 agent。
import fs from 'node:fs'
import path from 'node:path'
import { biliGet, isFatalBiliError, LoginExpiredError } from './api.js'
import type { BiliContext } from './context.js'
import { dataPath } from './paths.js'
import { appendJsonl } from './store.js'

export type WriteResult = { status: 'sent' | 'dry-run' | 'refused'; reason?: string; rpid?: string; preview?: string }

export class WriteRefusedError extends Error {}
export function refuse(reason: string): never { throw new WriteRefusedError(reason) }
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isBvid = (value: unknown): value is string => typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value)
export const isId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value)
export const validAt = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
export const localDay = (time: number | string): string => new Date(time).toLocaleDateString('sv-SE')
export const DAY_MS = 86400000

/** 只有文件不存在才算首次使用；损坏或无法读取时不能把额度清零。 */
export function readState<T>(dataDir: string, name: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(dataPath(dataDir, name), 'utf8').replace(/^\uFEFF/, '')) as T } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    return refuse(`${name} 无法读取或已损坏，停止写入，请先检查本地状态`)
  }
}

export function dryPreview(ctx: BiliContext, target: string, preview: string): WriteResult {
  appendJsonl(dataPath(ctx.dataDir, 'whale-log.jsonl'), { at: new Date(ctx.now()).toISOString(), kind: 'dry-run', target, note: preview })
  return { status: 'dry-run', preview }
}

type Account = { mid: string; wbi_img?: { img_url: string; sub_url: string } }
export async function account(ctx: BiliContext): Promise<Account> {
  if (!ctx.cred.sessdata || !ctx.cred.bili_jct) return refuse('登录凭据不完整，请重新扫码登录')
  const nav = await biliGet<{ isLogin?: boolean; mid?: string | number; wbi_img?: Account['wbi_img'] }>(ctx,
    'https://api.bilibili.com/x/web-interface/nav', { noCache: true })
  if (nav.code === -101 || nav.data?.isLogin === false) throw new LoginExpiredError()
  const mid = String(nav.data?.mid ?? '')
  if (nav.code !== 0 || !isId(mid) || nav.data?.isLogin !== true) return refuse('无法确认当前登录账号，停止发送')
  if (ctx.settings.self.mid && ctx.settings.self.mid !== mid) return refuse('当前登录账号与配置的小号不一致，请重新确认账号')
  return { mid, wbi_img: nav.data.wbi_img }
}

const pending = new Map<string, Promise<void>>()

/** 同一数据目录的「检查→发送→记账」串行执行，另以文件锁挡住其他进程。 */
export async function writeAction(ctx: BiliContext, action: () => Promise<WriteResult>): Promise<WriteResult> {
  const key = path.resolve(ctx.dataDir)
  const before = pending.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => { release = resolve })
  pending.set(key, done)
  await before
  let fd: number | undefined
  const file = dataPath(key, 'write-actions.lock')
  try {
    fs.mkdirSync(key, { recursive: true })
    // 与 traffic.ts 一样，只回收已确认进程退出的锁；状态未知时拒绝发送。
    if (fs.existsSync(file)) {
      const lock = readState<{ pid?: number }>(key, 'write-actions.lock', {})
      if (Number.isInteger(lock?.pid) && lock.pid! > 0) {
        try { process.kill(lock.pid!, 0) } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') fs.unlinkSync(file)
        }
      }
    }
    try { fd = fs.openSync(file, 'wx', 0o600) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'refused', reason: '有写操作正在处理，请稍后再试' }
      throw e
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
    return await action()
  } catch (e) {
    if (isFatalBiliError(e)) throw e
    return { status: 'refused', reason: e instanceof WriteRefusedError ? e.message : '写操作未完成，请检查本地状态或稍后重试' }
  } finally {
    try {
      if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(file) }
    } finally {
      if (pending.get(key) === done) pending.delete(key)
      release()
    }
  }
}

// 主人反馈共用的时间基准；不因旧通知重现、首次私信基线或轮询时间而刷新。
import { dataPath } from './paths.js'
import { writeJsonAtomic } from './store.js'
import { isObject, readState, validAt } from './write.js'

export function updateFeedback(dataDir: string, at: number, now: number): void {
  if (!Number.isFinite(at) || at <= 0) return
  at = Math.min(at, now) // B 站时间比本机快时按本机当前时间记，不写入未来时间

  const current = readState<unknown>(dataDir, 'feedback.json', {})
  if (!isObject(current) || (current.last != null && !validAt(current.last))) throw new Error('主人反馈记录损坏，停止更新反馈时间')
  if (validAt(current.last) && Date.parse(current.last) >= at) return
  writeJsonAtomic(dataPath(dataDir, 'feedback.json'), { ...current, last: new Date(at).toISOString() })
}

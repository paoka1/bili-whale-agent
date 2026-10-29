import type { BiliCred } from './creds.js'
import { RISK_DEFAULTS, type RiskSettings, type TrafficGuard } from './traffic.js'

export type BiliSettings = {
  owner: { mid: string; name: string }
  self: { mid: string; name: string }
  preferences: { like: string[]; dislike: string[] }
  risk: RiskSettings
  quota: { shareDaily: number }
  share: { enabled: boolean; via: 'comment' | 'dm'; minScore: number; silentAfterDays: number }
}

/** 每个 B 站函数都接收它：数据目录、凭据、请求保护、设置、是否演练。 */
export interface BiliContext {
  dataDir: string
  cred: BiliCred
  guard: TrafficGuard
  settings: BiliSettings
  dryRun: boolean
  now: () => number
}

/** 风控、额度、分享、不爱看的默认值与上游 tools/lib/config.mjs 的 DEFAULTS 一致；爱看默认为空，由用户填写 */
export function defaultSettings(): BiliSettings {
  return {
    owner: { mid: '', name: '' },
    self: { mid: '', name: '' },
    preferences: { like: [], dislike: ['带货', '擦边', '标题党', '纯搬运'] },
    risk: { ...RISK_DEFAULTS },
    quota: { shareDaily: 3 },
    share: { enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3 },
  }
}

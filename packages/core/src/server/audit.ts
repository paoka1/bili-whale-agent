// 只记录固定事件与结果；请求正文、密码、密钥、cookie 和异常原文均不进入审计。
import { appendJsonl, dataPath } from '@bili-whale/bili'

export type AuditEntry = {
  action: 'setup' | 'login' | 'logout' | 'logout-all' | 'config' | 'secrets' | 'password' | 'qr-start' | 'draft-approve' | 'draft-reject'
  ip: string; ok: boolean; target?: string
}
export function audit(dataDir: string, entry: AuditEntry): void {
  appendJsonl(dataPath(dataDir, 'audit.jsonl'), { at: new Date().toISOString(), ...entry })
}

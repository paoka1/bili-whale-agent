// 密钥独立保存；调用方只通过 maskSecrets 获取是否已设置。
import { z } from 'zod'
import { dataPath, writeJsonAtomic } from '@bili-whale/bili'
import { ConfigError, readSettingsFile } from './config.js'

const SecretsSchema = z.strictObject({ llmApiKey: z.string().default(''), visionApiKey: z.string().default('') })
export type Secrets = z.infer<typeof SecretsSchema>

export function loadSecrets(dataDir: string): Secrets {
  const result = SecretsSchema.safeParse(readSettingsFile(dataDir, 'secrets.json'))
  if (!result.success) throw new ConfigError('secrets.json 格式无效，请检查密钥文件')
  return result.data
}

export function saveSecrets(dataDir: string, patch: Partial<Secrets>): void {
  const current = loadSecrets(dataDir)
  writeJsonAtomic(dataPath(dataDir, 'secrets.json'), {
    llmApiKey: patch.llmApiKey ?? current.llmApiKey,
    visionApiKey: patch.visionApiKey ?? current.visionApiKey,
  }, 0o600)
}

export function maskSecrets(s: Secrets): { llmApiKey: boolean; visionApiKey: boolean } {
  return { llmApiKey: Boolean(s.llmApiKey), visionApiKey: Boolean(s.visionApiKey) }
}

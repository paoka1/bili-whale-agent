// 配置入口：只在读入文件或接收配置更新时校验，内部使用 AppConfig。
import fs from 'node:fs'
import { z } from 'zod'
import { dataPath, defaultSettings, normalizeRisk, RISK_DEFAULTS, writeJsonAtomic, type BiliSettings } from '@bili-whale/bili'

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError' }
}

const bili: BiliSettings = defaultSettings()
const account = z.strictObject({ mid: z.string().regex(/^(?:[1-9]\d*)?$/).default(''), name: z.string().default('') })
const model = z.strictObject({ baseURL: z.url({ protocol: /^https?$/ }).or(z.literal('')).default(''), model: z.string().default('') })
const time = z.string().regex(/^(?:(?:[01]?\d|2[0-3]):[0-5]\d|24:00)$/)
const night = z.strictObject({
  windows: z.array(z.strictObject({ start: time, end: time, wakes: z.number().int().min(0).max(12) }))
    .min(1).default(() => [{ start: '20:00', end: '24:00', wakes: 1 }]),
  skipChance: z.number().min(0).max(1).default(0.3),
  minGapMin: z.number().min(1).default(10),
  maxVideos: z.number().int().min(1).max(20).default(5),
  // 不填或 null = 各窗口次数之和（night.ts 的 maxWakes 计算）；不能把算出的默认值存进文件，否则改窗口后上限被写死
  maxWakesPerDay: z.number().int().min(0).max(12).nullable().optional(),
})

export const ConfigSchema = z.strictObject({
  llm: model.extend({ images: z.boolean().default(false) }).prefault({}),
  vision: model.extend({ enabled: z.boolean().default(false) }).prefault({}),
  persona: z.strictObject({ name: z.string().default('<角色名>'), ownerTitle: z.string().default('你'), selfClaim: z.string().default('我') }).prefault({}),
  owner: account.prefault({}),
  self: account.prefault({}),
  preferences: z.strictObject({
    // Task7 沿用上游 config.mjs 的中性口味；bili 包的空口味默认值用于未配置的底层调用。
    like: z.array(z.string()).default(() => ['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型']),
    dislike: z.array(z.string()).default(() => [...bili.preferences.dislike]),
  }).prefault({}),
  risk: z.strictObject({
    minGapMs: z.number().default(RISK_DEFAULTS.minGapMs),
    readHourly: z.number().default(RISK_DEFAULTS.readHourly),
    readDaily: z.number().default(RISK_DEFAULTS.readDaily),
    writeHourly: z.number().default(RISK_DEFAULTS.writeHourly),
    writeDaily: z.number().default(RISK_DEFAULTS.writeDaily),
    writeGapSec: z.number().default(RISK_DEFAULTS.writeGapSec),
    dmGapSec: z.number().default(RISK_DEFAULTS.dmGapSec),
  }).transform(normalizeRisk).prefault({}),
  quota: z.strictObject({ shareDaily: z.number().int().min(0).max(20).default(bili.quota.shareDaily) }).prefault({}),
  share: z.strictObject({
    enabled: z.boolean().default(bili.share.enabled), via: z.enum(['comment', 'dm']).default(bili.share.via),
    minScore: z.number().min(0).max(20).default(bili.share.minScore),
    silentAfterDays: z.number().min(0).default(bili.share.silentAfterDays),
  }).prefault({}),
  night: night.prefault({}),
  listen: z.strictObject({ comment: z.boolean().default(false), commentIntervalSec: z.number().int().min(1).default(60), dm: z.boolean().default(true) }).prefault({}),
  notify: z.strictObject({ type: z.enum(['none', 'dm', 'webhook']).default('none'), url: z.url({ protocol: /^https?$/ }).or(z.literal('')).default('') }).prefault({}),
  dryRun: z.boolean().default(true),
  server: z.strictObject({
    host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8787),
    tlsCert: z.string().default(''), tlsKey: z.string().default(''),
  }).prefault({}),
})

export type AppConfig = z.infer<typeof ConfigSchema>
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 包内共用的文件边界：不存在才使用默认值，损坏时不静默重置。 */
export function readSettingsFile(dataDir: string, name: 'config.json' | 'secrets.json'): unknown {
  try { return JSON.parse(fs.readFileSync(dataPath(dataDir, name), 'utf8').replace(/^\uFEFF/, '')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`无法读取 ${name}，请检查文件内容与权限`)
  }
}

function parseConfig(input: unknown): AppConfig {
  const result = ConfigSchema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]!
  const field = issue.path.join('.') || '根配置'
  throw new ConfigError(`配置无效：${field}（${issue.code === 'unrecognized_keys' ? '存在未知字段' : '格式或取值不符合要求'}）`)
}

export function loadConfig(dataDir: string): AppConfig {
  return parseConfig(readSettingsFile(dataDir, 'config.json'))
}

/** 对象递归合并，数组整组替换；有效性统一交给配置入口的 schema。 */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key,
    isObject(base[key]) && isObject(value) ? merge(base[key], value) : value,
  ])) }
}

export function saveConfig(dataDir: string, patch: unknown): AppConfig {
  const current = readSettingsFile(dataDir, 'config.json')
  if (!isObject(current)) throw new ConfigError('config.json 必须是配置对象，请先检查文件')
  const config = parseConfig(isObject(patch) ? merge(current, patch) : patch)
  writeJsonAtomic(dataPath(dataDir, 'config.json'), config)
  return config
}

function personaWithinLimit(text: string): string {
  // 与 systemPrompt 实际使用的长度一致，超出部分不会悄悄丢掉
  if (text.length > 3000) throw new ConfigError('人设不能超过 3000 字')
  return text
}

export function readPersona(dataDir: string): string {
  let text: string
  try { text = fs.readFileSync(dataPath(dataDir, 'persona.md'), 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new ConfigError('无法读取人设，请检查 persona.md 的权限')
  }
  return personaWithinLimit(text)
}

export function writePersona(dataDir: string, text: string): void {
  personaWithinLimit(text)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(dataPath(dataDir, 'persona.md'), text, 'utf8')
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RISK_DEFAULTS } from '@bili-whale/bili'
import { ConfigError, loadConfig, readPersona, saveConfig, writePersona } from '../src/config.js'
import { loadSecrets, maskSecrets, saveSecrets } from '../src/secrets.js'

const dirs: string[] = []
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-config-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true }) })

it('空目录合并中性默认值，默认开启演练且监听本机', () => {
  const config = loadConfig(directory())
  expect(config.dryRun).toBe(true)
  expect(config.llm.images).toBe(false)
  expect(config.server).toMatchObject({ host: '127.0.0.1', port: 8787 })
  expect(config.risk).toEqual(RISK_DEFAULTS)
  expect(config.preferences.like).toEqual(['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型'])
  expect(config.night).toMatchObject({ windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5, maxWakesPerDay: 1 })
  expect(config.listen).toEqual({ comment: false, commentIntervalSec: 60, dm: true })
})

it('局部保存递归合并，数组替换，配置变化即时生效且零额度不会被默认值覆盖', () => {
  const dir = directory()
  saveConfig(dir, { owner: { mid: '222', name: '主人' }, preferences: { like: ['猫咪', '工具'] } })
  const config = saveConfig(dir, { owner: { name: '新名字' }, preferences: { like: ['音乐'] }, quota: { shareDaily: 0 }, dryRun: false })
  expect(config.owner).toEqual({ mid: '222', name: '新名字' })
  expect(config.preferences.like).toEqual(['音乐'])
  expect(config.quota.shareDaily).toBe(0)
  expect(loadConfig(dir)).toEqual(config)
})

it('允许跨午夜窗口，拒绝无效时间且保留原配置', () => {
  const dir = directory()
  saveConfig(dir, { night: { windows: [{ start: '23:00', end: '02:00', wakes: 1 }] } })
  const file = path.join(dir, 'config.json')
  const before = fs.readFileSync(file, 'utf8')
  expect(() => saveConfig(dir, { night: { windows: [{ start: '25:00', end: '26:00', wakes: 1 }] } })).toThrow(ConfigError)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
})

it('未知字段被拒绝，错误信息不带输入内容', () => {
  const dir = directory()
  expect(() => saveConfig(dir, { evil: 'sk-SECRET123' })).toThrow(ConfigError)
  expect(() => saveConfig(dir, { evil: 'sk-SECRET123' })).not.toThrow('sk-SECRET123')
  expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false)
})

it('读入损坏的本地配置会报错，不能静默恢复默认并覆盖文件', () => {
  const dir = directory()
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '{broken')
  expect(() => loadConfig(dir)).toThrow(ConfigError)
  expect(() => saveConfig(dir, { dryRun: false })).toThrow(ConfigError)
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
})

it('密钥独立持久化、局部更新，只以布尔值表示已设置并限制权限', () => {
  const dir = directory()
  expect(loadSecrets(dir)).toEqual({ llmApiKey: '', visionApiKey: '' })
  expect(maskSecrets(loadSecrets(dir))).toEqual({ llmApiKey: false, visionApiKey: false })
  saveSecrets(dir, { llmApiKey: 'sk-SECRET123' })
  saveSecrets(dir, { visionApiKey: 'vision-SECRET456' })
  const secrets = loadSecrets(dir)
  expect(secrets).toEqual({ llmApiKey: 'sk-SECRET123', visionApiKey: 'vision-SECRET456' })
  expect(maskSecrets(secrets)).toEqual({ llmApiKey: true, visionApiKey: true })
  saveConfig(dir, { llm: { baseURL: 'https://llm.example.com/v1', model: 'test-model' } })
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).not.toMatch(/sk-SECRET123|vision-SECRET456/)
  if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777).toBe(0o600)
})

it('配置不能混入 API key，嵌套未知字段也拒绝', () => {
  const dir = directory()
  expect(() => saveConfig(dir, { llm: { apiKey: 'sk-SECRET123' } })).toThrow(ConfigError)
  expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false)
})

// 上限与系统提示实际使用的长度一致（3000 字），保存时就拒绝，不在运行时悄悄截断
it('人设独立保存，允许 3000 字，超限拒绝并保留原文', () => {
  const dir = directory()
  expect(readPersona(dir)).toBe('')
  const text = '中'.repeat(3000)
  writePersona(dir, text)
  expect(readPersona(dir)).toBe(text)
  expect(() => writePersona(dir, text + '中')).toThrow(ConfigError)
  expect(readPersona(dir)).toBe(text)
})

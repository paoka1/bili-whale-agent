import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDataDir } from '@bili-whale/bili'
import { parseCliArgs, startService } from '../src/cli.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) await fs.promises.rm(d, { recursive: true, force: true }) })

it('解析 start 的监听地址与端口', () => {
  expect(parseCliArgs(['start', '--host', '0.0.0.0', '--port', '9000'])).toEqual({ command: 'start', host: '0.0.0.0', port: 9000 })
  expect(parseCliArgs(['start'])).toEqual({ command: 'start' })
})

it.each([[['start', '--port', '70000']], [['start', '--port', 'abc']], [['serve']], [['start', '--evil']]])('非法参数报错 %j', (argv) => {
  expect(() => parseCliArgs(argv)).toThrow()
})

it('--data 覆盖 BILI_WHALE_HOME', () => {
  vi.stubEnv('BILI_WHALE_HOME', path.join(os.tmpdir(), 'from-env'))
  const { data } = parseCliArgs(['start', '--data', path.join(os.tmpdir(), 'from-flag')])
  expect(resolveDataDir({ dir: data })).toBe(path.join(os.tmpdir(), 'from-flag'))
})

it('启动后网页接口可用、首次生成设置码与人设模板，stop 后端口关闭', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cli-'))
  dirs.push(dataDir)
  const lines: string[] = []
  const service = await startService({ dataDir, host: '127.0.0.1', port: 0, log: (line) => lines.push(line) })
  const res = await fetch(`${service.url}/api/status`)
  expect(res.status).toBe(401)
  expect(await res.json()).toMatchObject({ needsSetup: true })
  expect(lines.join('\n')).toMatch(/设置码[^\d]*\d{8}/)
  expect(fs.readFileSync(path.join(dataDir, 'persona.md'), 'utf8')).toContain('角色名')
  await service.stop()
  await expect(fetch(`${service.url}/api/status`)).rejects.toThrow()
})

it('监听非本机且没有 HTTPS 时打印明文提示', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cli-'))
  dirs.push(dataDir)
  const lines: string[] = []
  const service = await startService({ dataDir, host: '0.0.0.0', port: 0, log: (line) => lines.push(line) })
  await service.stop()
  expect(lines.join('\n')).toContain('明文')
})

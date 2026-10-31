import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import * as bili from '@bili-whale/bili'
import { ConfigSchema, writePersona } from '../src/config.js'
import { createModel } from '../src/model.js'
import { runAgent } from '../src/runner.js'
import { fakeBili, json } from '../../bili/test/helpers.js'

vi.mock('@bili-whale/bili', async (original) => ({
  ...await original<typeof import('@bili-whale/bili')>(), captureFrames: vi.fn(), briefVideo: vi.fn(),
}))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })
const cfg = ConfigSchema.parse({})
const secrets = { llmApiKey: 'main-SECRET', visionApiKey: 'vision-SECRET' }
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] })
const call = (toolName: string, input = {}, toolCallId = 'call') => ({ content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [] })

it('工具调用后收尾，运行记录与摘要落盘，人设进入系统消息', async () => {
  const s = fakeBili(() => undefined)
  writePersona(s.dataDir, '喜欢安静地观察。')
  const model = new MockLanguageModelV4({ doGenerate: [call('quota_status'), text('给主人信：今晚看到了猫。')] })
  const record = await runAgent({ kind: 'wake', prompt: '醒来吧' }, { ctx: s.ctx, cfg, secrets, model })
  expect(record).toMatchObject({ status: 'ok', steps: 2, toolCalls: [{ name: 'quota_status', ok: true }], draftsAdded: 0, finalText: '给主人信：今晚看到了猫。' })
  expect(bili.readJsonl(path.join(s.dataDir, 'runs.jsonl'))).toEqual([record])
  expect(bili.readLog(s.dataDir)).toMatchObject([{ kind: 'run', note: expect.stringContaining('ok') }])
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('喜欢安静地观察。')
})

it('一直调用工具也在第 40 步停止', async () => {
  const s = fakeBili(() => undefined)
  const model = new MockLanguageModelV4({ doGenerate: async () => call('quota_status', {}, String(model.doGenerateCalls.length)) })
  const onToolCall = vi.fn()
  const record = await runAgent({ kind: 'manual', prompt: '继续' }, { ctx: s.ctx, cfg, secrets, model, onToolCall })
  expect(record).toMatchObject({ status: 'ok', steps: 40 })
  expect(onToolCall).toHaveBeenCalledTimes(40)
  expect(onToolCall).toHaveBeenLastCalledWith({ name: 'quota_status', ok: true })
  expect(record.toolCalls).toHaveLength(40)
  expect(model.doGenerateCalls).toHaveLength(40)
})

it('模型报错记为 failed，记录和日志不包含密钥或 cookie', async () => {
  const s = fakeBili(() => undefined)
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('调用失败 main-SECRET vision-SECRET SESS-SECRET JCT') } })
  const record = await runAgent({ kind: 'manual', prompt: '开始' }, { ctx: s.ctx, cfg, secrets, model })
  expect(record.status).toBe('failed')
  expect(record.error).toContain('调用失败')
  expect(JSON.stringify([record, bili.readLog(s.dataDir), bili.readJsonl(path.join(s.dataDir, 'runs.jsonl'))])).not.toMatch(/main-SECRET|vision-SECRET|SESS-SECRET|JCT/)
})

it.each([
  [new bili.TrafficError('请求保护暂停'), 'paused'],
  [new bili.LoginExpiredError(), 'login-expired'],
])('工具遇到 %s 立即结束，当前步骤的后续写操作也不执行', async (error, status) => {
  const s = fakeBili((url) => {
    if (error instanceof bili.LoginExpiredError) return url.pathname.endsWith('/nav') ? undefined : json({ code: -101, message: '登录失效' })
    throw error
  })
  const first = call('comments', { bvid: 'BV1AAAAAAAAA' })
  first.content.push({ type: 'tool-call', toolCallId: 'later', toolName: 'diary_append', input: JSON.stringify({ which: 'private', markdown: '不应写入' }) })
  const model = new MockLanguageModelV4({ doGenerate: [first, text('不应继续')] })
  const record = await runAgent({ kind: 'wake', prompt: '开始' }, { ctx: s.ctx, cfg, secrets, model })
  expect(record.status).toBe(status)
  expect(record.toolCalls).toEqual([{ name: 'comments', ok: false, error: error.message }])
  expect(model.doGenerateCalls).toHaveLength(1)
  expect(bili.readDiaries(s.dataDir).private).toBe('')
})

it('只拒绝这一次请求的保护错误（预算、重复）交给模型，本轮继续写日记', async () => {
  const s = fakeBili(() => { throw new bili.TrafficError('已达到本地写操作预算，本次不发送', { refusal: true }) })
  const model = new MockLanguageModelV4({ doGenerate: [
    call('comments', { bvid: 'BV1AAAAAAAAA' }), call('diary_append', { which: 'private', markdown: '额度满了，下次再说' }, '2'), text('完成'),
  ] })
  const record = await runAgent({ kind: 'wake', prompt: '开始' }, { ctx: s.ctx, cfg, secrets, model })
  expect(record.status).toBe('ok')
  expect(record.toolCalls).toEqual([{ name: 'comments', ok: false, error: expect.stringContaining('已达到本地写操作预算') }, { name: 'diary_append', ok: true }])
  expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('已达到本地写操作预算')
  expect(bili.readDiaries(s.dataDir).private).toContain('额度满了')
})

it('取消信号中止运行并记为 timeout', async () => {
  const s = fakeBili(() => undefined)
  const signal = AbortSignal.abort()
  const model = new MockLanguageModelV4({ doGenerate: text('不应请求') })
  const record = await runAgent({ kind: 'manual', prompt: '开始' }, { ctx: s.ctx, cfg, secrets, model, signal })
  expect(record.status).toBe('timeout')
  expect(model.doGenerateCalls).toHaveLength(0)
})

it('主模型看图时下一步用 user 图片消息，后续步骤保留图片且不泄漏路径', async () => {
  const s = fakeBili(() => undefined)
  const imagePath = path.join(s.dataDir, 'frame.jpg')
  const bytes = Buffer.from('ffd8ffe000104a46494600ffd9', 'hex')
  fs.writeFileSync(imagePath, bytes)
  vi.mocked(bili.briefVideo).mockResolvedValue({ meta: { title: '猫' }, subtitles: '字幕' } as bili.VideoBrief)
  vi.mocked(bili.captureFrames).mockResolvedValue({ ok: true, imagePath, frameTimes: [1] })
  const model = new MockLanguageModelV4({ doGenerate: [call('video_deep', { bvid: 'BV1AAAAAAAAA' }), call('quota_status', {}, 'next'), text('看到猫了')] })
  const record = await runAgent({ kind: 'wake', prompt: '看视频' }, { ctx: s.ctx, cfg: ConfigSchema.parse({ llm: { images: true } }), secrets, model })
  expect(record.status).toBe('ok')
  for (const request of model.doGenerateCalls.slice(1)) {
    const images = request.prompt.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((p) => p.type === 'file')
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ mediaType: 'image/jpeg', data: { type: 'data', data: bytes } })
    expect(JSON.stringify(request.prompt)).not.toContain(imagePath)
  }
})

it('新草稿计入运行结果，被业务闸门拒绝的工具记录为失败', async () => {
  const s = fakeBili(() => undefined)
  const model = new MockLanguageModelV4({ doGenerate: [
    call('reply_draft', { bvid: 'BV1AAAAAAAAA', oid: '101', root: '8', parent: '9', who: '访客', src: '你好', message: '谢谢' }),
    call('dm_owner', { message: '未配置主人不能发送' }, 'dm'), text('结束'),
  ] })
  const record = await runAgent({ kind: 'wake', prompt: '处理消息' }, { ctx: s.ctx, cfg, secrets, model })
  expect(record).toMatchObject({ status: 'ok', draftsAdded: 1 })
  expect(record.toolCalls).toEqual([{ name: 'reply_draft', ok: true }, { name: 'dm_owner', ok: false, error: '私信需要先配置主人 mid' }])
})

it('参数不对的工具调用也记下失败原因', async () => {
  const s = fakeBili(() => undefined)
  const model = new MockLanguageModelV4({ doGenerate: [call('diary_append', { markdown: '漏了 which' }), text('结束')] })
  const record = await runAgent({ kind: 'wake', prompt: '开始' }, { ctx: s.ctx, cfg, secrets, model })
  expect(record.toolCalls).toEqual([{ name: 'diary_append', ok: false, error: expect.stringContaining('which') }])
})

it('主模型使用配置的兼容接口、模型名与密钥', async () => {
  const s = fakeBili(() => undefined)
  const config = ConfigSchema.parse({ llm: { baseURL: 'https://llm.example.com/v1', model: 'fixture-main' } })
  const fetcher = vi.fn(async () => json({ id: 'test', object: 'chat.completion', created: 0, model: 'fixture-main', choices: [{ index: 0, message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  vi.stubGlobal('fetch', fetcher)
  const record = await runAgent({ kind: 'manual', prompt: '开始' }, { ctx: s.ctx, cfg: config, secrets, model: createModel(config, secrets) })
  expect(record.status).toBe('ok')
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(url)).toBe('https://llm.example.com/v1/chat/completions')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer main-SECRET')
  expect(JSON.parse(String(init.body)).model).toBe('fixture-main')
  expect(String(init.body)).not.toMatch(/main-SECRET|vision-SECRET|SESS-SECRET|JCT/)
})

import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'
import { configPayload, plainHttpWarning, type AppConfig } from '../src/api'
import { kindOf, progressText, toolLabel } from '../src/labels'

it('动态类型显示中文，系统记录标为淡显，不认识的原样显示', () => {
  expect(kindOf('watch').label).toBe('看视频')
  expect(kindOf('scheduler')).toMatchObject({ label: '系统', system: true })
  expect(kindOf('看视频').label).toBe('看视频')
  expect(toolLabel('video_deep')).toBe('深读')
})

afterEach(cleanup)

it('日记里的脚本与事件属性被清除', () => {
  render(<Markdown source={'hi <img src=x onerror="alert(1)"> <script>alert(2)</script> [a](javascript:alert(3))'} />)
  const html = document.body.innerHTML
  expect(html).not.toMatch(/onerror|<script|javascript:/)
})

it('正常的 markdown 照常渲染', () => {
  render(<Markdown source={'# 今天\n\n看了 [一个视频](https://www.bilibili.com/video/BV1AAAAAAAAA)'} />)
  expect(document.querySelector('h1')?.textContent).toBe('今天')
  expect(document.querySelector('a')?.getAttribute('href')).toBe('https://www.bilibili.com/video/BV1AAAAAAAAA')
})

// 2026-10-29 真机：页面先打开、后扫码，保存时把旧的空 self 写回，覆盖了扫码记下的账号
it('保存配置不带 self（扫码登录写的，网页上不可编辑）', () => {
  const cfg = { dryRun: true, owner: { mid: '1', name: '主人' }, self: { mid: '', name: '' } } as unknown as AppConfig
  const sent = JSON.parse(JSON.stringify(configPayload(cfg)))
  expect(sent).not.toHaveProperty('self')
  expect(sent.owner).toEqual({ mid: '1', name: '主人' })
})

it.each([
  ['http:', '192.168.1.10', true],
  ['http:', 'localhost', false],
  ['http:', '127.0.0.1', false],
  ['https:', 'example.com', false],
])('明文传输提示：%s//%s → %s', (protocol, hostname, expected) => {
  expect(plainHttpWarning({ protocol, hostname })).toBe(expected)
})

it('运行进度：连续同名工具合并计数，失败的标出来', () => {
  expect(progressText([{ name: 'diary_read', ok: true }, { name: 'search', ok: true }, { name: 'search', ok: true }, { name: 'video_deep', ok: false }]))
    .toBe('读日记 → 搜索 ×2 → 深读 ✗')
})

it('分层日记的新工具有中文名，旧的写日记仍能显示', () => {
  expect([toolLabel('diary_append'), toolLabel('memory_write'), toolLabel('diary_search'), toolLabel('diary_write')])
    .toEqual(['追加日记', '整理记忆', '查旧日记', '写日记'])
})

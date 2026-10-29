import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'
import { plainHttpWarning } from '../src/api'

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

it.each([
  ['http:', '192.168.1.10', true],
  ['http:', 'localhost', false],
  ['http:', '127.0.0.1', false],
  ['https:', 'example.com', false],
])('明文传输提示：%s//%s → %s', (protocol, hostname, expected) => {
  expect(plainHttpWarning({ protocol, hostname })).toBe(expected)
})

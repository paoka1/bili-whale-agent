import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { assertBiliUrl, NetDeniedError } from '../src/net.js'

it('只放行 B 站域名', () => {
  expect(assertBiliUrl('https://api.bilibili.com/x/web-interface/nav').hostname).toBe('api.bilibili.com')
  expect(assertBiliUrl('https://bilibili.com/').hostname).toBe('bilibili.com')
  expect(assertBiliUrl('https://upos-sz-mirrorcos.bilivideo.com/a.mp4')).toBeTruthy()
  expect(assertBiliUrl('https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/a.mp4')).toBeTruthy()
  expect(assertBiliUrl('http://i0.hdslb.com/bfs/archive/a.jpg')).toBeTruthy()
  expect(assertBiliUrl(new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/generate'))).toBeTruthy()
  expect(() => assertBiliUrl('https://evil.com/?u=bilibili.com')).toThrow(NetDeniedError)
  expect(() => assertBiliUrl('https://bilibili.com.evil.com/')).toThrow(NetDeniedError)
  expect(() => assertBiliUrl('https://notbilibili.com/')).toThrow(NetDeniedError)
  expect(() => assertBiliUrl('file:///etc/passwd')).toThrow(NetDeniedError)
  expect(() => assertBiliUrl('not a url')).toThrow(NetDeniedError)
})

it('bili 包里只有 traffic.ts 直接调用 fetch', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  for (const f of fs.readdirSync(src, { recursive: true }) as string[]) {
    if (!f.endsWith('.ts') || f === 'traffic.ts') continue
    const text = fs.readFileSync(path.join(src, f), 'utf8')
    expect(/(?<![.\w])fetch\(|globalThis\.fetch/.test(text), f).toBe(false)
  }
})

import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { dmOwner, type DmOptions } from '../src/dm.js'
import { postComment } from '../src/comment.js'
import { readJson, writeJsonAtomic } from '../src/store.js'
import { TrafficError } from '../src/traffic.js'
import { fakeBili, json } from './helpers.js'
import { BV, fakeWrites, share } from './write-helpers.js'

it('未互关时拒绝私信', async () => {
  const { ctx, calls } = fakeBili((url) => {
    if (url.pathname.endsWith('/nav')) return json({ code: 0, data: { isLogin: true, mid: 111 } })
    if (url.pathname === '/x/relation') return json({ code: 0, data: { attribute: 2 } })
  }, { dryRun: false })
  ctx.settings.owner = { mid: '222', name: '主人' }
  expect(await dmOwner(ctx, { message: '今天也过得不错' })).toMatchObject({ status: 'refused' })
  expect(calls.some((c) => c.init.method === 'POST')).toBe(false)
})

it('只发 owner.mid，外部传入收信人字段不起作用', async () => {
  const s = fakeWrites()
  expect(await dmOwner(s.ctx, { message: '今天过得不错', receiver: '999' } as DmOptions)).toEqual({ status: 'sent' })
  const form = new URLSearchParams(String(s.writes()[0]!.init.body))
  expect(form.get('msg[receiver_id]')).toBe('222')
  expect(form.get('msg[sender_uid]')).toBe('111')
  expect(form.get('msg[receiver_type]')).toBe('1')
  expect(JSON.parse(form.get('msg[content]')!)).toEqual({ content: '今天过得不错' })
  expect(form.get('csrf')).toBe('JCT')
  expect(readJson(path.join(s.dataDir, 'dm-quota.json'), {})).toMatchObject({ mid: '222', count: 1 })
})

it('当天已锁定其他收信人时拒绝，次日可以锁定当前主人', async () => {
  const s = fakeWrites()
  const date = new Date(s.ctx.now()).toLocaleDateString('sv-SE')
  writeJsonAtomic(path.join(s.dataDir, 'dm-quota.json'), { date, mid: '999', count: 1, at: new Date(s.ctx.now()).toISOString() })
  expect(await dmOwner(s.ctx, { message: '你好' })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
  s.advance(86400000)
  expect(await dmOwner(s.ctx, { message: '新的一天你好' })).toEqual({ status: 'sent' })
  expect(readJson(path.join(s.dataDir, 'dm-quota.json'), {})).toMatchObject({ mid: '222', count: 1 })
})

it('缺少主人 mid 或主人就是自己时拒绝', async () => {
  const s = fakeWrites()
  s.ctx.settings.owner.mid = ''
  expect(await dmOwner(s.ctx, { message: '你好' })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
  s.ctx.settings.owner.mid = '111'
  expect(await dmOwner(s.ctx, { message: '你好' })).toMatchObject({ status: 'refused', reason: expect.stringContaining('自己') })
  expect(s.writes()).toHaveLength(0)
})

it('普通推送不要求分享评分，也不受分享开关影响', async () => {
  const s = fakeWrites()
  s.ctx.settings.share.enabled = false
  expect(await dmOwner(s.ctx, { message: '醒来记录已经写好了' })).toEqual({ status: 'sent' })
  expect(readJson(path.join(s.dataDir, 'quota.json'), {})).toMatchObject({ log: [{ type: 'dm', share: false }] })
})

it('私信分享附上目标视频链接，和评论共享七天冷却', async () => {
  const s = fakeWrites()
  expect(await dmOwner(s.ctx, { message: '发现一段很好的讲解', share: { ...share, bvid: BV } })).toEqual({ status: 'sent' })
  const form = new URLSearchParams(String(s.writes()[0]!.init.body))
  expect(JSON.parse(form.get('msg[content]')!).content).toContain(`https://www.bilibili.com/video/${BV}`)
  expect(await postComment(s.ctx, { bvid: BV, message: '再分享一下', share })).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(1)
})

it('关分享和评分不合格在任何网络请求前就拒绝', async () => {
  const s = fakeWrites()
  s.ctx.settings.share.enabled = false
  expect(await dmOwner(s.ctx, { message: '分享', share: { ...share, bvid: BV } })).toMatchObject({ status: 'refused' })
  s.ctx.settings.share.enabled = true
  expect(await dmOwner(s.ctx, { message: '分享', share: { ...share, bvid: BV, score: 2 } })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
})

it('每次发送前重新核实互关关系，不用旧缓存', async () => {
  let mutual = true
  const s = fakeWrites({ handler: (url) => url.pathname === '/x/relation' ? json({ code: 0, data: { attribute: mutual ? 6 : 2 } }) : undefined })
  expect(await dmOwner(s.ctx, { message: '第一条' })).toMatchObject({ status: 'sent' })
  mutual = false
  expect(await dmOwner(s.ctx, { message: '第二条' })).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(1)
  expect(s.calls.filter((c) => c.url.pathname === '/x/relation')).toHaveLength(2)
})

it('稳定设备 ID 跨两次发送复用，并设置文件权限', async () => {
  const s = fakeWrites()
  expect(await dmOwner(s.ctx, { message: '第一条' })).toMatchObject({ status: 'sent' })
  expect(await dmOwner(s.ctx, { message: '第二条' })).toMatchObject({ status: 'sent' })
  const ids = s.writes().map((c) => new URLSearchParams(String(c.init.body)).get('msg[dev_id]'))
  expect(ids[0]).toMatch(/^WEB-[A-F0-9-]+$/)
  expect(ids[1]).toBe(ids[0])
  expect(fs.readFileSync(path.join(s.dataDir, 'dev_id'), 'utf8').trim()).toBe(ids[0])
  if (process.platform !== 'win32') expect(fs.statSync(path.join(s.dataDir, 'dev_id')).mode & 0o777).toBe(0o600)
})

it('设备 ID 不能保存时停止发送', async () => {
  const s = fakeWrites()
  fs.mkdirSync(path.join(s.dataDir, 'dev_id'))
  expect(await dmOwner(s.ctx, { message: '普通消息' })).toMatchObject({ status: 'refused' })
  expect(s.writes()).toHaveLength(0)
})

it('演练核实互关后返回预览，不锁收信人、不生成设备 ID、不消耗额度', async () => {
  const s = fakeWrites()
  s.ctx.dryRun = true
  expect(await dmOwner(s.ctx, { message: '演练消息' })).toEqual({ status: 'dry-run', preview: '演练消息' })
  expect(s.writes()).toHaveLength(0)
  for (const name of ['dev_id', 'dm-quota.json', 'quota.json']) expect(fs.existsSync(path.join(s.dataDir, name))).toBe(false)
})

it('发送失败不增加成功计数，不回显接口原文', async () => {
  const s = fakeWrites({ handler: (url) => url.pathname.endsWith('/send_msg') ? json({ code: 21000, message: 'SESS-SECRET JCT' }) : undefined })
  const result = await dmOwner(s.ctx, { message: '普通消息' })
  expect(result).toMatchObject({ status: 'refused' })
  expect(JSON.stringify(result)).not.toMatch(/SESS-SECRET|JCT/)
  expect(readJson(path.join(s.dataDir, 'dm-quota.json'), {})).toMatchObject({ mid: '222', count: 0 })
  expect(fs.existsSync(path.join(s.dataDir, 'quota.json'))).toBe(false)
})

it('网络结果不确定时上抛，且当天改主人也不能换收信人', async () => {
  const s = fakeWrites({ handler: (url) => {
    if (url.pathname.endsWith('/send_msg')) throw new Error('SESS-SECRET JCT')
  } })
  await expect(dmOwner(s.ctx, { message: '普通消息' })).rejects.toBeInstanceOf(TrafficError)
  s.ctx.settings.owner.mid = '999'
  expect(await dmOwner(s.ctx, { message: '再试一次' })).toMatchObject({ status: 'refused', reason: expect.stringContaining('收信人') })
  expect(s.writes()).toHaveLength(1)
})

it.each(['{', 'null', '{}', '{"date":"2026-10-29","mid":"222","count":-1,"at":"bad"}'])('私信账本损坏时拒绝发送 %s', async (content) => {
  const s = fakeWrites()
  const file = path.join(s.dataDir, 'dm-quota.json')
  fs.writeFileSync(file, content)
  expect(await dmOwner(s.ctx, { message: '普通消息' })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
  expect(fs.readFileSync(file, 'utf8')).toBe(content)
})

it.each(['', ' ', 'x'.repeat(301)])('空私信或超长私信被拒', async (message) => {
  const s = fakeWrites()
  expect(await dmOwner(s.ctx, { message })).toMatchObject({ status: 'refused' })
  expect(s.calls).toHaveLength(0)
})

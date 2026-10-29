import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '../src/store.js'
import { cookieHeader, loadCred, saveCred } from '../src/creds.js'
import { dataPath, resolveDataDir } from '../src/paths.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-store-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

it('原子写入并设置权限', () => {
  const f = path.join(dir, 'sub', 'a.json')
  writeJsonAtomic(f, { a: 1 }, 0o600)
  expect(readJson(f, {})).toEqual({ a: 1 })
  if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  expect(fs.readdirSync(path.dirname(f))).toEqual(['a.json'])
})

it('文件缺失或损坏时返回默认值，并容忍 BOM', () => {
  expect(readJson(path.join(dir, 'none.json'), { x: 1 })).toEqual({ x: 1 })
  fs.writeFileSync(path.join(dir, 'bad.json'), '{broken')
  expect(readJson(path.join(dir, 'bad.json'), [])).toEqual([])
  fs.writeFileSync(path.join(dir, 'bom.json'), '﻿{"ok":true}')
  expect(readJson(path.join(dir, 'bom.json'), {})).toEqual({ ok: true })
})

it('jsonl 追加与读取最近 N 条，跳过坏行', () => {
  const f = path.join(dir, 'log.jsonl')
  for (const i of [1, 2, 3]) appendJsonl(f, { i })
  fs.appendFileSync(f, 'not json\n')
  appendJsonl(f, { i: 4 })
  expect(readJsonl(f)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }])
  expect(readJsonl(f, 2)).toEqual([{ i: 3 }, { i: 4 }])
})

it('数据目录：参数优先，其次环境变量，默认 ~/.bili-whale', () => {
  const old = process.env.BILI_WHALE_HOME
  try {
    process.env.BILI_WHALE_HOME = path.join(dir, 'env')
    expect(resolveDataDir({ dir: path.join(dir, 'arg') })).toBe(path.join(dir, 'arg'))
    expect(resolveDataDir()).toBe(path.join(dir, 'env'))
    delete process.env.BILI_WHALE_HOME
    expect(resolveDataDir()).toBe(path.join(os.homedir(), '.bili-whale'))
    expect(dataPath('/d', 'a', 'b.json')).toBe(path.join('/d', 'a', 'b.json'))
  } finally {
    if (old === undefined) delete process.env.BILI_WHALE_HOME
    else process.env.BILI_WHALE_HOME = old
  }
})

it('凭据：保存为 0600，读取时清理空白和引号，缺失返回 null', () => {
  expect(loadCred(dir)).toBeNull()
  saveCred(dir, { sessdata: ' "abc" ', bili_jct: 'JCT\n', buvid3: '' })
  if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
  const cred = loadCred(dir)
  expect(cred).toEqual({ sessdata: 'abc', bili_jct: 'JCT', buvid3: '' })
  expect(cookieHeader(cred!)).toBe('SESSDATA=abc; bili_jct=JCT')
  expect(cookieHeader({ ...cred!, buvid3: 'B3' })).toBe('SESSDATA=abc; bili_jct=JCT; buvid3=B3')
})

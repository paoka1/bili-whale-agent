import fs from 'node:fs'
import path from 'node:path'

/** 读 JSON；文件缺失或损坏时返回 fallback。容忍 UTF-8 BOM。 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T
  } catch {
    return fallback
  }
}

/** 先写临时文件再改名，避免写到一半时崩溃留下残缺文件。 */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? undefined : { mode })
    if (mode !== undefined) {
      try { fs.chmodSync(temp, mode) } catch { /* Windows 不支持 POSIX 权限 */ }
    }
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(row) + '\n')
}

/** 读 jsonl，跳过坏行；给了 limit 时只返回最后 limit 条（最新的在后）。 */
export function readJsonl<T>(file: string, limit?: number): T[] {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const rows: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line) as T) } catch { /* 跳过坏行 */ }
  }
  return limit === undefined ? rows : rows.slice(-limit)
}

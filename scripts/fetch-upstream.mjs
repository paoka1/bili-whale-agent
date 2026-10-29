// 克隆上游 dsh-bili-whale v0.4.6 到 upstream/，作为移植参考（已在 .gitignore 中忽略）
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'upstream')

if (existsSync(dest)) {
  console.log('upstream/ 已存在，跳过')
} else {
  execFileSync('git', ['clone', '--depth', '1', '--branch', 'v0.4.6', 'https://github.com/Alterssss/dsh-bili-whale', dest], { stdio: 'inherit' })
}

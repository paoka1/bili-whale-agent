// ffmpeg 可选依赖定位。移植自 upstream/tools/lib/ffmpeg.mjs。
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from './paths.js'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch { return false }
}

/** FFMPEG > PATH > 数据目录/bin。显式指定了无效路径时返回 null，避免悄悄使用其他版本。 */
export function findFfmpeg(dataDir = resolveDataDir()): string | null {
  if (process.env.FFMPEG) {
    const file = path.resolve(process.env.FFMPEG)
    return executable(file) ? file : null
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.resolve(dir.replace(/^"|"$/g, ''), EXE)
    if (executable(file)) return file
  }
  const bundled = path.resolve(dataDir, 'bin', EXE)
  return executable(bundled) ? bundled : null
}

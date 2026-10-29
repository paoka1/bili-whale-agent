import os from 'node:os'
import path from 'node:path'

/** 数据目录：参数 > 环境变量 BILI_WHALE_HOME > ~/.bili-whale */
export function resolveDataDir(opt: { dir?: string } = {}): string {
  return path.resolve(opt.dir ?? process.env.BILI_WHALE_HOME ?? path.join(os.homedir(), '.bili-whale'))
}

export const dataPath = (dataDir: string, ...parts: string[]): string => path.join(dataDir, ...parts)

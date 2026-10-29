#!/usr/bin/env node
import { main } from './cli.js'

main().catch((e: unknown) => {
  console.error(`启动失败：${(e as Error)?.message ?? e}`)
  process.exit(1)
})

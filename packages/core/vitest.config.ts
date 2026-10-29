import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@bili-whale/bili': fileURLToPath(new URL('../bili/src/index.ts', import.meta.url)) } },
})

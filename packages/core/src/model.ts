import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { AppConfig } from './config.js'
import type { Secrets } from './secrets.js'

export function createModel(cfg: AppConfig, secrets: Secrets) {
  return createOpenAICompatible({ name: 'llm', baseURL: cfg.llm.baseURL, apiKey: secrets.llmApiKey })(cfg.llm.model)
}

import { createSystemOneClient } from "./system-one.ts"
import type { JevClient } from "./types.ts"

/** Model versions are explicit because inquiry calibration is model-specific. */
export const DEFAULT_OPENROUTER_MODEL = "typesafe/jev-1.13"

export const OPENROUTER_SYSTEMONE_URL = "https://openrouter.ai/api/v1/systemone"

export const createOpenRouterClient = (
  apiKey: string,
  model: string = DEFAULT_OPENROUTER_MODEL,
): JevClient => createSystemOneClient({
  provider: "openrouter",
  url: OPENROUTER_SYSTEMONE_URL,
  model,
  headers: { authorization: `Bearer ${apiKey}` },
})

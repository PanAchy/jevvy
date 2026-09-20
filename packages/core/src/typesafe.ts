import { createSystemOneClient } from "./system-one.ts"
import type { JevClient } from "./types.ts"

/** Model versions are explicit because inquiry calibration is model-specific. */
export const DEFAULT_TYPESAFE_MODEL = "jev-1.13.0"

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone"

export const createTypeSafeClient = (
  apiKey: string,
  model: string = DEFAULT_TYPESAFE_MODEL,
): JevClient => createSystemOneClient({
  provider: "typesafe",
  url: TYPESAFE_SYSTEMONE_URL,
  model,
  headers: { authorization: `Bearer ${apiKey}` },
})

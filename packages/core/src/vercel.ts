import { createSystemOneClient } from "./system-one.ts"
import type { JevClient } from "./types.ts"

/** Vercel's model ID for TypeSafe Jev. */
export const DEFAULT_VERCEL_MODEL = "typesafe-ai/jev"

export const VERCEL_SYSTEMONE_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone"

export const createVercelClient = (
  apiKey: string,
  model: string = DEFAULT_VERCEL_MODEL,
): JevClient => createSystemOneClient({
  provider: "vercel",
  url: VERCEL_SYSTEMONE_URL,
  model,
  headers: { authorization: `Bearer ${apiKey}` },
})

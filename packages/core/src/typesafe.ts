import type { JevClient } from "./types.ts"
import { createTypeSafeRuntime } from "./typesafe-runtime.ts"

/** Model versions are explicit because inquiry calibration is model-specific. */
export const DEFAULT_TYPESAFE_MODEL = "jev-1.13.0"

export const createTypeSafeClient = (
  apiKey: string,
  model: string = DEFAULT_TYPESAFE_MODEL,
  transport: typeof globalThis.fetch = globalThis.fetch,
): JevClient => {
  const runtime = createTypeSafeRuntime(apiKey, model, transport)

  return {
    evaluate: runtime.evaluate,
    dispose: runtime.dispose,
  }
}

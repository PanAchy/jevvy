import { Schema } from "effect"
import { createSystemOneClient, parseSystemOneResponse } from "./system-one.ts"
import type { JevClient, JevResult, NoulQuestion } from "./types.ts"

export const ZEN_SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone"

export const DEFAULT_ZEN_MODEL = "jev-1.13-free"

export interface ZenBodyInput {
  readonly model?: unknown
  readonly answers?: unknown
}

export const isZenBody = Schema.is(Schema.Struct({
  model: Schema.optional(Schema.Unknown),
  answers: Schema.optional(Schema.Unknown),
}))

export const parseZenResponse = (
  raw: ZenBodyInput,
  questions?: Readonly<Record<string, NoulQuestion>>,
): JevResult | undefined => parseSystemOneResponse(raw, questions)

export const createZenClient = (
  apiKey: string,
  model: string = DEFAULT_ZEN_MODEL,
  transport: typeof globalThis.fetch = globalThis.fetch,
): JevClient => createSystemOneClient({
  provider: "zen",
  url: ZEN_SYSTEMONE_URL,
  model,
  headers: { "x-api-key": apiKey },
  transport,
})

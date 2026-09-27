import { createSystemOneClient } from "./system-one.ts"
import type { JevClient } from "./types.ts"

export const DEFAULT_LAYA_ENDPOINT = "http://127.0.0.1:8000/v1/systemone"

export const DEFAULT_LAYA_MODEL = "english"

export interface LayaClientOptions {
  readonly endpoint?: string
  readonly model?: string
  readonly apiKey?: string
}

export const createLayaClient = (options: LayaClientOptions = {}): JevClient => createSystemOneClient({
  provider: "laya",
  url: options.endpoint ?? DEFAULT_LAYA_ENDPOINT,
  model: options.model ?? DEFAULT_LAYA_MODEL,
  headers: options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
  modelIdentity: "routing.model",
})

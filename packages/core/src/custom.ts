import { createSystemOneClient } from "./system-one.ts"
import type { JevClient } from "./types.ts"

export interface CustomSystemOneClientOptions {
  readonly endpoint: string
  readonly model: string
  readonly apiKey?: string
}

export const createCustomSystemOneClient = (
  options: CustomSystemOneClientOptions,
): JevClient => createSystemOneClient({
  provider: "custom",
  url: options.endpoint,
  model: options.model,
  headers: options.apiKey === undefined
    ? {}
    : { authorization: `Bearer ${options.apiKey}` },
})

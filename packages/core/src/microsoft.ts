import { createSystemOneClient } from "./system-one.ts"
import type { JevClient } from "./types.ts"

export const MICROSOFT_DECISION_MODEL = "microsoft-decision-1"

export interface MicrosoftClientOptions {
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
}

export const createMicrosoftClient = (options: MicrosoftClientOptions): JevClient => createSystemOneClient({
  provider: "microsoft",
  url: options.endpoint,
  model: options.model,
  headers: { "api-key": options.apiKey },
})

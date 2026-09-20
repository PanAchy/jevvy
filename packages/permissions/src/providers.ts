import {
  createTypeSafeClient,
  createZenClient,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_ZEN_MODEL,
  JevProvider,
} from "./core.ts"
import type { JevClient, JevProvider as JevProviderType } from "./core.ts"
import { Redacted, Schema } from "effect"

export const ProviderPreference = Schema.Literals(["auto", ...JevProvider.literals])

export type ProviderPreference = Schema.Schema.Type<typeof ProviderPreference>

export type ProviderApiKeys = {
  readonly [Provider in JevProviderType]?: Redacted.Redacted<string>
}

interface ProviderDefinition {
  readonly automaticPriority: number
  readonly model: string
  readonly createClient: (apiKey: string) => JevClient
}

const providerDefinitions = {
  zen: {
    automaticPriority: 0,
    model: DEFAULT_ZEN_MODEL,
    createClient: createZenClient,
  },
  typesafe: {
    automaticPriority: 1,
    model: DEFAULT_TYPESAFE_MODEL,
    createClient: createTypeSafeClient,
  },
} satisfies Readonly<Record<JevProviderType, ProviderDefinition>>

const automaticProviders = [...JevProvider.literals].sort(
  (left, right) => providerDefinitions[left].automaticPriority - providerDefinitions[right].automaticPriority,
)

export interface SelectedProvider {
  readonly provider: JevProviderType
  readonly model: string
  readonly client: JevClient
  readonly redact: (text: string) => string
}

export const createProvider = (
  provider: JevProviderType,
  apiKey: string,
  client: JevClient = providerDefinitions[provider].createClient(apiKey),
): SelectedProvider => ({
  provider,
  model: providerDefinitions[provider].model,
  client,
  redact: (text) => apiKey.length === 0 ? text : text.replaceAll(apiKey, "[redacted]"),
})

export const selectConfiguredProvider = (
  preference: ProviderPreference,
  apiKeys: ProviderApiKeys,
): SelectedProvider | undefined => {
  const candidates: readonly JevProviderType[] = preference === "auto"
    ? automaticProviders
    : [preference]

  for (const provider of candidates) {
    const apiKey = apiKeys[provider]

    if (apiKey !== undefined) return createProvider(provider, Redacted.value(apiKey))
  }

  return undefined
}

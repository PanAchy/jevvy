import {
  createCustomSystemOneClient,
  createOpenRouterClient,
  createTypeSafeClient,
  createVercelClient,
  createZenClient,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
  JevProvider,
} from "./core.ts"
import type { JevClient, JevProvider as JevProviderType } from "./core.ts"
import { Redacted, Schema } from "effect"

export const BuiltInProvider = Schema.Literals(["zen", "typesafe", "openrouter", "vercel"])

export type BuiltInProvider = Schema.Schema.Type<typeof BuiltInProvider>

export type ProviderSelection =
  | {
      readonly provider: BuiltInProvider
      readonly apiKey?: Redacted.Redacted<string>
    }
  | {
      readonly provider: "custom"
      readonly endpoint: string
      readonly model: string
      readonly apiKey?: Redacted.Redacted<string>
    }

interface ProviderDefinition {
  readonly displayName: string
  readonly apiKeyEnvironment: string
  readonly model: string
  readonly createClient: (apiKey: string) => JevClient
}

const providerDefinitions = {
  zen: {
    displayName: "OpenCode Zen",
    apiKeyEnvironment: "OPENCODE_API_KEY",
    model: DEFAULT_ZEN_MODEL,
    createClient: createZenClient,
  },
  typesafe: {
    displayName: "TypeSafe AI",
    apiKeyEnvironment: "TYPESAFE_API_KEY",
    model: DEFAULT_TYPESAFE_MODEL,
    createClient: createTypeSafeClient,
  },
  openrouter: {
    displayName: "OpenRouter",
    apiKeyEnvironment: "OPENROUTER_API_KEY",
    model: DEFAULT_OPENROUTER_MODEL,
    createClient: createOpenRouterClient,
  },
  vercel: {
    displayName: "Vercel AI Gateway",
    apiKeyEnvironment: "AI_GATEWAY_API_KEY",
    model: DEFAULT_VERCEL_MODEL,
    createClient: createVercelClient,
  },
} satisfies Readonly<Record<BuiltInProvider, ProviderDefinition>>

export const providerDisplayName = (provider: JevProviderType): string =>
  provider === "custom" ? "Custom endpoint" : providerDefinitions[provider].displayName

export const providerApiKeyEnvironment = (provider: BuiltInProvider): string =>
  providerDefinitions[provider].apiKeyEnvironment

export interface SelectedProvider {
  readonly provider: JevProviderType
  readonly model: string
  readonly client: JevClient
  readonly redact: (text: string) => string
}

const redactWith = (apiKey: string | undefined) =>
  (text: string): string => apiKey === undefined || apiKey.length === 0
    ? text
    : text.replaceAll(apiKey, "[redacted]")

export const createBuiltInProvider = (
  provider: BuiltInProvider,
  apiKey: string,
  client: JevClient = providerDefinitions[provider].createClient(apiKey),
): SelectedProvider => ({
  provider,
  model: providerDefinitions[provider].model,
  client,
  redact: redactWith(apiKey),
})

export const createConfiguredProvider = (
  selection: ProviderSelection,
): SelectedProvider | undefined => {
  const apiKey = selection.apiKey === undefined
    ? undefined
    : Redacted.value(selection.apiKey)

  if (selection.provider === "custom") {
    return {
      provider: "custom",
      model: selection.model,
      client: createCustomSystemOneClient({
        endpoint: selection.endpoint,
        model: selection.model,
        apiKey,
      }),
      redact: redactWith(apiKey),
    }
  }

  return apiKey === undefined
    ? undefined
    : createBuiltInProvider(selection.provider, apiKey)
}

export { JevProvider }

import {
  createCustomSystemOneClient,
  createLayaClient,
  createOpenRouterClient,
  createTypeSafeClient,
  createVercelClient,
  createZenClient,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_LAYA_ENDPOINT,
  DEFAULT_LAYA_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
  JevProvider,
} from "./core.ts"
import type { JevClient, JevProvider as JevProviderType } from "./core.ts"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export const BuiltInProvider = Schema.Literals(["zen", "typesafe", "openrouter", "vercel", "laya"])

export type BuiltInProvider = Schema.Schema.Type<typeof BuiltInProvider>

export type ProviderSelection =
  | {
      readonly provider: Exclude<BuiltInProvider, "laya">
      readonly model?: string
      readonly apiKey?: Redacted.Redacted<string>
      readonly opencodeCredential?: string
    }
  | {
      readonly provider: "laya"
      readonly endpoint?: string
      readonly model?: string
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
  readonly calibratedModel?: string
  readonly createClient: (apiKey: string) => JevClient
}

const providerDefinitions = {
  zen: {
    displayName: "OpenCode Zen",
    apiKeyEnvironment: "OPENCODE_API_KEY",
    model: DEFAULT_ZEN_MODEL,
    calibratedModel: "jev-1.13-free",
    createClient: createZenClient,
  },
  typesafe: {
    displayName: "TypeSafe AI",
    apiKeyEnvironment: "TYPESAFE_API_KEY",
    model: DEFAULT_TYPESAFE_MODEL,
    calibratedModel: DEFAULT_TYPESAFE_MODEL,
    createClient: createTypeSafeClient,
  },
  openrouter: {
    displayName: "OpenRouter",
    apiKeyEnvironment: "OPENROUTER_API_KEY",
    model: DEFAULT_OPENROUTER_MODEL,
    calibratedModel: DEFAULT_OPENROUTER_MODEL,
    createClient: createOpenRouterClient,
  },
  vercel: {
    displayName: "Vercel AI Gateway",
    apiKeyEnvironment: "AI_GATEWAY_API_KEY",
    model: DEFAULT_VERCEL_MODEL,
    calibratedModel: DEFAULT_VERCEL_MODEL,
    createClient: createVercelClient,
  },
  laya: {
    displayName: "Laya",
    apiKeyEnvironment: "LAYA_API_KEY",
    model: DEFAULT_LAYA_MODEL,
    createClient: (apiKey: string) => createLayaClient({ apiKey }),
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

export const shippedPolicyProvenance = ({ provider, model }: Pick<SelectedProvider, "provider" | "model">): "calibrated-defaults" | "shipped-defaults-unverified" => {
  if (provider === "custom" || provider === "laya") return "shipped-defaults-unverified"

  return model === providerDefinitions[provider].calibratedModel ? "calibrated-defaults" : "shipped-defaults-unverified"
}

const redactWith = (apiKey: string | undefined) =>
  (text: string): string => apiKey === undefined || apiKey.length === 0
    ? text
    : text.replaceAll(apiKey, "[redacted]")

export const createBuiltInProvider = (
  provider: Exclude<BuiltInProvider, "laya">,
  apiKey: string,
  model: string = providerDefinitions[provider].model,
): SelectedProvider => ({
  provider,
  model,
  client: providerDefinitions[provider].createClient(apiKey, model),
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

  if (selection.provider === "laya") {
    const model = selection.model ?? DEFAULT_LAYA_MODEL

    return {
      provider: "laya",
      model,
      client: createLayaClient({
        endpoint: selection.endpoint ?? DEFAULT_LAYA_ENDPOINT,
        model,
        apiKey,
      }),
      redact: redactWith(apiKey),
    }
  }

  return apiKey === undefined
    ? undefined
    : createBuiltInProvider(selection.provider, apiKey, selection.model)
}

export { JevProvider }

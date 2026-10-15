import {
  createCustomSystemOneClient,
  createLayaClient,
  createMicrosoftClient,
  createOpenAIClient,
  createOpenRouterClient,
  createTypeSafeClient,
  createVercelClient,
  createZenClient,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENAI_MODEL,
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

export const BuiltInProvider = Schema.Literals(["zen", "typesafe", "openrouter", "vercel", "openai", "microsoft", "laya"])

export type BuiltInProvider = Schema.Schema.Type<typeof BuiltInProvider>

export type ProviderSelection =
  | {
      readonly provider: Exclude<BuiltInProvider, "laya" | "microsoft">
      readonly apiKey?: Redacted.Redacted<string>
    }
  | {
      readonly provider: "laya"
      readonly endpoint?: string
      readonly model?: string
      readonly apiKey?: Redacted.Redacted<string>
    }
  | {
      readonly provider: "microsoft"
      readonly endpoint: string
      readonly model: string
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
  readonly setupDescription: string
  readonly shippedPolicy: "jev" | "unverified"
}

const providerPresets = {
  zen: {
    displayName: "OpenCode Zen",
    apiKeyEnvironment: "OPENCODE_API_KEY",
    model: DEFAULT_ZEN_MODEL,
    createClient: createZenClient,
    setupDescription: "Jev through OpenCode Zen",
    shippedPolicy: "jev",
  },
  typesafe: {
    displayName: "TypeSafe AI",
    apiKeyEnvironment: "TYPESAFE_API_KEY",
    model: DEFAULT_TYPESAFE_MODEL,
    createClient: createTypeSafeClient,
    setupDescription: "Jev directly from TypeSafe",
    shippedPolicy: "jev",
  },
  openrouter: {
    displayName: "OpenRouter",
    apiKeyEnvironment: "OPENROUTER_API_KEY",
    model: DEFAULT_OPENROUTER_MODEL,
    createClient: createOpenRouterClient,
    setupDescription: "Jev through OpenRouter",
    shippedPolicy: "jev",
  },
  vercel: {
    displayName: "Vercel AI Gateway",
    apiKeyEnvironment: "AI_GATEWAY_API_KEY",
    model: DEFAULT_VERCEL_MODEL,
    createClient: createVercelClient,
    setupDescription: "Jev through Vercel AI Gateway",
    shippedPolicy: "jev",
  },
  openai: {
    displayName: "OpenAI Decisions",
    apiKeyEnvironment: "OPENAI_API_KEY",
    model: DEFAULT_OPENAI_MODEL,
    createClient: createOpenAIClient,
    setupDescription: "Decisions API, gpt-6-luna",
    shippedPolicy: "unverified",
  },
  laya: {
    displayName: "Laya",
    apiKeyEnvironment: "LAYA_API_KEY",
    model: DEFAULT_LAYA_MODEL,
    createClient: (apiKey: string) => createLayaClient({ apiKey }),
    setupDescription: "your endpoint, own calibrated policy",
    shippedPolicy: "unverified",
  },
} satisfies Readonly<Record<Exclude<BuiltInProvider, "microsoft">, ProviderDefinition>>

const providerDefinitions = {
  ...providerPresets,
  microsoft: {
    displayName: "Microsoft Decision",
    apiKeyEnvironment: "AZURE_AI_API_KEY",
    setupDescription: "Microsoft-Decision-1 in Azure Foundry",
    shippedPolicy: "unverified",
  },
  custom: {
    displayName: "Custom endpoint",
    setupDescription: "any System One-compatible server",
    shippedPolicy: "unverified",
  },
}

export const providerDisplayName = (provider: JevProviderType): string =>
  providerDefinitions[provider].displayName

export const providerSetupChoices = (["zen", "typesafe", "openrouter", "vercel", "laya", "custom", "openai", "microsoft"] as const)
  .map((value) => ({ value, title: providerDefinitions[value].displayName, description: providerDefinitions[value].setupDescription }))

export const shippedPolicyProvenance = (provider: JevProviderType): "calibrated-defaults" | "shipped-defaults-unverified" =>
  providerDefinitions[provider].shippedPolicy === "jev" ? "calibrated-defaults" : "shipped-defaults-unverified"

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

const createCredentialPreset = (
  provider: Exclude<BuiltInProvider, "microsoft">,
  apiKey: string,
  client: JevClient = providerPresets[provider].createClient(apiKey),
): SelectedProvider => ({
  provider,
  model: providerPresets[provider].model,
  client,
  redact: redactWith(apiKey),
})

export const createConfiguredProvider = (
  selection: ProviderSelection,
): SelectedProvider | undefined => {
  const apiKey = selection.apiKey === undefined
    ? undefined
    : Redacted.value(selection.apiKey)

  if (selection.provider === "microsoft") {
    return apiKey === undefined ? undefined : {
      provider: "microsoft",
      model: selection.model,
      client: createMicrosoftClient({ endpoint: selection.endpoint, model: selection.model, apiKey }),
      redact: redactWith(apiKey),
    }
  }

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
    : createCredentialPreset(selection.provider, apiKey)
}

export { JevProvider }

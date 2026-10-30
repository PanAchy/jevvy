import {
  createCustomSystemOneClient,
  createCloudflareClient,
  createLayaClient,
  createMicrosoftClient,
  createOpenAIClient,
  createOpenRouterClient,
  createTypeSafeClient,
  createVercelClient,
  createZenClient,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_CLOUDFLARE_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_LAYA_ENDPOINT,
  DEFAULT_LAYA_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
  MICROSOFT_DECISION_MODEL,
  JevProvider,
} from "./core.ts"
import type { CloudflareModel, JevClient, JevProvider as JevProviderType } from "./core.ts"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export const BuiltInProvider = Schema.Literals(["zen", "typesafe", "openrouter", "vercel", "openai", "microsoft", "cloudflare", "laya"])

export type BuiltInProvider = Schema.Schema.Type<typeof BuiltInProvider>

export type ProviderSelection =
  | {
      readonly provider: Exclude<BuiltInProvider, "laya" | "microsoft" | "openai" | "cloudflare">
      readonly model?: string
      readonly apiKey?: Redacted.Redacted<string>
      readonly opencodeCredential?: string
    }
  | {
      readonly provider: "openai"
      readonly apiKey?: Redacted.Redacted<string>
    }
  | {
      readonly provider: "cloudflare"
      readonly accountId: string
      readonly model?: CloudflareModel
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
  readonly calibratedModel?: string
  readonly createClient: (apiKey: string, model: string) => JevClient
  readonly setupDescription: string
}

const providerPresets = {
  zen: {
    displayName: "OpenCode Zen",
    apiKeyEnvironment: "OPENCODE_API_KEY",
    model: DEFAULT_ZEN_MODEL,
    calibratedModel: "jev-1.13-free",
    createClient: createZenClient,
    setupDescription: `paid ${DEFAULT_ZEN_MODEL} default; model override in jevvy.jsonc`,
  },
  typesafe: {
    displayName: "TypeSafe AI",
    apiKeyEnvironment: "TYPESAFE_API_KEY",
    model: DEFAULT_TYPESAFE_MODEL,
    calibratedModel: DEFAULT_TYPESAFE_MODEL,
    createClient: createTypeSafeClient,
    setupDescription: "Jev directly from TypeSafe",
  },
  openrouter: {
    displayName: "OpenRouter",
    apiKeyEnvironment: "OPENROUTER_API_KEY",
    model: DEFAULT_OPENROUTER_MODEL,
    calibratedModel: DEFAULT_OPENROUTER_MODEL,
    createClient: createOpenRouterClient,
    setupDescription: "Jev through OpenRouter",
  },
  vercel: {
    displayName: "Vercel AI Gateway",
    apiKeyEnvironment: "AI_GATEWAY_API_KEY",
    model: DEFAULT_VERCEL_MODEL,
    calibratedModel: DEFAULT_VERCEL_MODEL,
    createClient: createVercelClient,
    setupDescription: "Jev through Vercel AI Gateway",
  },
  openai: {
    displayName: "OpenAI Decisions",
    apiKeyEnvironment: "OPENAI_API_KEY",
    model: DEFAULT_OPENAI_MODEL,
    createClient: createOpenAIClient,
    setupDescription: "Decisions API, gpt-6-luna",
  },
} satisfies Readonly<Record<Exclude<BuiltInProvider, "microsoft" | "laya" | "cloudflare">, ProviderDefinition>>

const providerDefinitions = {
  ...providerPresets,
  cloudflare: {
    displayName: "Cloudflare Clef",
    apiKeyEnvironment: "CLOUDFLARE_API_TOKEN",
    setupDescription: "Clef or Clef-flash on Workers AI; not calibrated by Jevvy",
  },
  microsoft: {
    displayName: "Microsoft Decision",
    apiKeyEnvironment: "AZURE_AI_API_KEY",
    setupDescription: "Microsoft-Decision-1 in Azure Foundry",
  },
  laya: {
    displayName: "Laya",
    apiKeyEnvironment: "LAYA_API_KEY",
    setupDescription: "your endpoint, own calibrated policy",
  },
  custom: {
    displayName: "Custom endpoint",
    setupDescription: "any System One-compatible server",
  },
} satisfies Readonly<Record<JevProviderType, { readonly displayName: string; readonly setupDescription: string; readonly apiKeyEnvironment?: string }>>

export const providerDisplayName = (provider: JevProviderType): string =>
  providerDefinitions[provider].displayName

export const providerSetupChoices = (["zen", "typesafe", "openrouter", "vercel", "laya", "custom", "openai", "microsoft", "cloudflare"] as const)
  .map((value) => ({ value, title: providerDefinitions[value].displayName, description: providerDefinitions[value].setupDescription }))

export const providerApiKeyEnvironment = (provider: BuiltInProvider): string =>
  providerDefinitions[provider].apiKeyEnvironment

export interface SelectedProvider {
  readonly provider: JevProviderType
  readonly requestedModel: string
  readonly expectedModel: string
  readonly client: JevClient
  readonly redact: (text: string) => string
}

export const shippedPolicyProvenance = ({ provider, requestedModel }: Pick<SelectedProvider, "provider" | "requestedModel">): "calibrated-defaults" | "shipped-defaults-unverified" => {
  const definition = providerDefinitions[provider]

  return "calibratedModel" in definition && requestedModel === definition.calibratedModel ? "calibrated-defaults" : "shipped-defaults-unverified"
}

const redactWith = (apiKey: string | undefined) =>
  (text: string): string => apiKey === undefined || apiKey.length === 0
    ? text
    : text.replaceAll(apiKey, "[redacted]")

export const createBuiltInProvider = (
  provider: Exclude<BuiltInProvider, "laya" | "microsoft" | "cloudflare">,
  apiKey: string,
  model: string = providerPresets[provider].model,
): SelectedProvider => ({
  provider,
  requestedModel: model,
  expectedModel: model,
  client: providerPresets[provider].createClient(apiKey, model),
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
      requestedModel: selection.model,
      expectedModel: MICROSOFT_DECISION_MODEL,
      client: createMicrosoftClient({ endpoint: selection.endpoint, model: selection.model, apiKey }),
      redact: redactWith(apiKey),
    }
  }

  if (selection.provider === "cloudflare") {
    const model = selection.model ?? DEFAULT_CLOUDFLARE_MODEL

    return apiKey === undefined ? undefined : {
      provider: "cloudflare",
      requestedModel: model,
      expectedModel: model,
      client: createCloudflareClient({ accountId: selection.accountId, model, apiKey }),
      redact: redactWith(apiKey),
    }
  }

  if (selection.provider === "custom") {
    return {
      provider: "custom",
      requestedModel: selection.model,
      expectedModel: selection.model,
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
      requestedModel: model,
      expectedModel: model,
      client: createLayaClient({
        endpoint: selection.endpoint ?? DEFAULT_LAYA_ENDPOINT,
        model,
        apiKey,
      }),
      redact: redactWith(apiKey),
    }
  }

  if (selection.provider === "openai") return apiKey === undefined ? undefined : createBuiltInProvider("openai", apiKey)

  return apiKey === undefined
    ? undefined
    : createBuiltInProvider(selection.provider, apiKey, selection.model)
}

export { JevProvider }

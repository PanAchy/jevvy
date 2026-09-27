import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  password,
  select,
  text,
} from "@clack/prompts"
import { Option, Redacted, Schema } from "effect"
import { parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { DEFAULT_LAYA_ENDPOINT, DEFAULT_LAYA_MODEL } from "../core.ts"
import { providerDisplayName } from "../providers.ts"
import type { InitHarness, InitPlan, InitProvider, InitResult } from "./index.ts"
import { accent } from "./theme.ts"

type ProviderName = InitProvider["provider"]

const LayaCheckpoint = Schema.Literals(["english", "multilingual", "typed-decisions"])

type LayaCheckpoint = typeof LayaCheckpoint.Type

const LayaPromptConfig = Schema.Struct({
  providers: Schema.optionalKey(Schema.Struct({
    laya: Schema.optionalKey(Schema.Struct({
      endpoint: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(LayaCheckpoint),
      apiKey: Schema.optionalKey(Schema.String),
    })),
  })),
})

type LayaPrompts = {
  readonly text: typeof text
  readonly select: typeof select<LayaCheckpoint>
  readonly confirm: typeof confirm
  readonly password: typeof password
}

interface LayaPromptDefaults {
  readonly endpoint?: string
  readonly model?: LayaCheckpoint
  readonly hasApiKey?: boolean
  readonly urlNeedsReentry?: boolean
}

type LayaSelectionDraft = {
  provider: "laya"
  endpoint?: string
  model?: string
  apiKey?: Redacted.Redacted<string>
}

const harnessLabels = {
  opencode: "OpenCode",
  claude: "Claude Code",
} satisfies Readonly<Record<InitHarness, string>>

export const harnessPrompt = {
  message: "Which harnesses should use Jevvy?",
  options: [
    { value: "opencode" as const, label: harnessLabels.opencode, hint: "permission plugin" },
    { value: "claude" as const, label: harnessLabels.claude, hint: "PermissionRequest hook" },
  ],
  initialValues: ["opencode", "claude"] satisfies readonly InitHarness[],
  required: true,
}

const required = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? "This value is required" : undefined

export const endpointError = (value: string | undefined): string | undefined => {
  const missing = required(value)

  if (missing !== undefined) return missing

  try {
    const endpoint = new URL(value ?? "")

    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      return "Use an http:// or https:// endpoint"
    }

    return undefined
  } catch {
    return "Enter a valid endpoint URL"
  }
}

export const layaEndpointError = (value: string | undefined): string | undefined => {
  const error = endpointError(value)

  if (error !== undefined) return error

  const endpoint = new URL(value ?? "")

  return endpoint.username !== "" || endpoint.password !== ""
    ? "Use a Bearer API key instead of URL credentials"
    : undefined
}

export const layaPromptDefaults = (existing: string | undefined): LayaPromptDefaults => {
  if (existing === undefined) return {}

  const errors: ParseError[] = []
  const document: unknown = parse(existing, errors, { allowTrailingComma: true, disallowComments: false })

  if (errors.length > 0) return {}

  const previous = Option.getOrUndefined(Schema.decodeUnknownOption(LayaPromptConfig, {
    onExcessProperty: "ignore",
  })(document))?.providers?.laya

  if (previous === undefined) return {}

  const savedEndpoint = previous.endpoint === undefined || layaEndpointError(previous.endpoint) !== undefined
    ? undefined
    : new URL(previous.endpoint)

  const urlNeedsReentry = savedEndpoint !== undefined && (savedEndpoint.search !== "" || savedEndpoint.hash !== "")

  const defaults: LayaPromptDefaults = {
    endpoint: savedEndpoint !== undefined && !urlNeedsReentry ? previous.endpoint : undefined,
    model: previous.model,
    hasApiKey: previous.apiKey !== undefined && previous.apiKey.length > 0,
  }

  return urlNeedsReentry ? { ...defaults, urlNeedsReentry: true } : defaults
}

const stop = (): undefined => {
  cancel("Jevvy setup cancelled")

  return undefined
}

const promptApiKey = async (
  message: string,
  askPassword = password,
): Promise<Redacted.Redacted<string> | undefined> => {
  const answer = await askPassword({ message: accent(message), validate: required })

  return isCancel(answer) ? undefined : Redacted.make(answer)
}

export const promptLayaProvider = async (
  prompts: LayaPrompts = { text, select, confirm, password },
  defaults: LayaPromptDefaults = {},
): Promise<Extract<InitProvider, { provider: "laya" }> | undefined> => {
  const endpoint = await prompts.text({
    message: accent(defaults.urlNeedsReentry
      ? "Laya System One URL (re-enter URL with private parameters)"
      : "Laya System One URL"),
    initialValue: defaults.endpoint ?? DEFAULT_LAYA_ENDPOINT,
    validate: layaEndpointError,
  })

  if (isCancel(endpoint)) return undefined

  const model = await prompts.select({
    message: accent("Laya checkpoint"),
    options: [
      { value: "english", label: "English" },
      { value: "multilingual", label: "Multilingual" },
      { value: "typed-decisions", label: "Typed decisions" },
    ],
    initialValue: defaults.model ?? DEFAULT_LAYA_MODEL,
  })

  if (isCancel(model)) return undefined

  const hasApiKey = await prompts.confirm({
    message: accent("Does your Laya server require a Bearer API key?"),
    initialValue: defaults.hasApiKey ?? false,
  })

  if (isCancel(hasApiKey)) return undefined

  const apiKey = hasApiKey
    ? await promptApiKey(defaults.hasApiKey ? "Re-enter the Laya API key" : "Enter the Laya API key", prompts.password)
    : undefined

  if (hasApiKey && apiKey === undefined) return undefined

  const selectedEndpoint = endpoint.trim()

  const selection: LayaSelectionDraft = { provider: "laya" }

  if (selectedEndpoint !== DEFAULT_LAYA_ENDPOINT) selection.endpoint = selectedEndpoint

  if (model !== DEFAULT_LAYA_MODEL) selection.model = model

  if (apiKey !== undefined) selection.apiKey = apiKey

  return selection
}

const promptProvider = async (
  provider: ProviderName,
  layaDefaults: LayaPromptDefaults,
): Promise<InitProvider | undefined> => {
  if (provider === "laya") return promptLayaProvider(undefined, layaDefaults)

  if (provider === "custom") {
    const endpoint = await text({
      message: accent("System One endpoint"),
      placeholder: "http://127.0.0.1:8080/v1/decisions",
      validate: endpointError,
    })

    if (isCancel(endpoint)) return undefined

    const model = await text({
      message: accent("Model identifier"),
      placeholder: "typesafe/jev",
      validate: required,
    })

    if (isCancel(model)) return undefined

    const hasApiKey = await confirm({
      message: accent("Does this endpoint require a Bearer API key?"),
      initialValue: true,
    })

    if (isCancel(hasApiKey)) return undefined

    if (!hasApiKey) {
      return { provider: "custom", endpoint: endpoint.trim(), model: model.trim() }
    }

    const apiKey = await promptApiKey("Enter the endpoint API key")

    return apiKey === undefined
      ? undefined
      : { provider: "custom", endpoint: endpoint.trim(), model: model.trim(), apiKey }
  }

  const labels = {
    zen: "OpenCode Zen API key",
    typesafe: "TypeSafe API key",
    openrouter: "OpenRouter API key",
    vercel: "Vercel AI Gateway key",
  } as const

  const apiKey = await promptApiKey(`Enter your ${labels[provider]}`)

  return apiKey === undefined ? undefined : { provider, apiKey }
}

const displayEndpoint = (value: string): string => {
  const endpoint = new URL(value)

  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    return `${endpoint.origin} (URL details saved in private config)`
  }

  return `${endpoint.origin}${endpoint.pathname}`
}

const providerDetails = (provider: InitProvider): string[] => {
  if (provider.provider === "laya") {
    return [`Server: ${displayEndpoint(provider.endpoint ?? DEFAULT_LAYA_ENDPOINT)}`]
  }

  if (provider.provider === "custom") {
    return [`Server: ${displayEndpoint(provider.endpoint)}`, `Model: ${provider.model}`]
  }

  return []
}

const planProviderLabel = (provider: InitProvider): string =>
  provider.provider === "laya"
    ? `Laya (${provider.model ?? DEFAULT_LAYA_MODEL})`
    : providerDisplayName(provider.provider)

export const initPlanSummary = (plan: InitPlan, configPath: string): string => [
  `${planProviderLabel(plan.provider)} for ${plan.harnesses.map((harness) => harnessLabels[harness]).join(" + ")}`,
  `Config: ${configPath}`,
  ...providerDetails(plan.provider),
  ...(plan.provider.apiKey !== undefined ? ["Bearer key: saved in private config"] : []),
].join("\n")

export const initConfirmationMessage = (plan: InitPlan, configPath: string): string => [
  accent("Save config and install integrations?"),
  initPlanSummary(plan, configPath),
  ...(plan.provider.provider === "laya"
    ? ["", "Laya needs a checkpoint-specific policy; without one, auto-approval stays off."]
    : []),
].join("\n")

export const layaNextSteps = (result: InitResult): string => {
  const steps = [
    "If this checkpoint has no calibrated policy, start Laya and calibrate a candidate.",
    "Add passing questions to providers.laya.policy with the matching checkpoint.",
  ]

  if (result.harnesses.includes("opencode")) {
    steps.push(
      "Restart OpenCode after saving the policy (shared service: opencode service restart).",
      "Check plugin status: jevvy.permissions must be active.",
    )
  }

  steps.push("Optional skill: npx skills add PanAchy/jevvy --skill calibrate-permissions")

  return steps.join("\n")
}

export const promptInitPlan = async (configPath: string, existing?: string): Promise<InitPlan | undefined> => {
  intro(accent("Set up Jevvy"))

  const harnesses = await multiselect<InitHarness>({
    ...harnessPrompt,
    message: accent(harnessPrompt.message),
  })

  if (isCancel(harnesses)) return stop()

  const providerName = await select<ProviderName>({
    message: accent("Which System One provider should Jevvy use?"),
    options: [
      { value: "zen", label: providerDisplayName("zen") },
      { value: "typesafe", label: providerDisplayName("typesafe") },
      { value: "openrouter", label: providerDisplayName("openrouter") },
      { value: "vercel", label: providerDisplayName("vercel") },
      { value: "laya", label: providerDisplayName("laya"), hint: "your endpoint, own calibrated policy" },
      { value: "custom", label: providerDisplayName("custom"), hint: "any System One-compatible server" },
    ],
  })

  if (isCancel(providerName)) return stop()

  const provider = await promptProvider(providerName, layaPromptDefaults(existing))

  if (provider === undefined) return stop()

  const accepted = await confirm({
    message: initConfirmationMessage({ harnesses, provider }, configPath),
    initialValue: true,
  })

  if (isCancel(accepted) || !accepted) return stop()

  return { harnesses, provider }
}

export const showInitProgress = (): void => log.step("Saving config and installing integrations")

export const showInitError = (message: string): void => {
  log.error(message)
  outro("Jevvy setup did not complete")
}

export const showInitResult = (result: InitResult): void => {
  log.success(`Installed Jevvy in ${result.harnesses.map((harness) => harnessLabels[harness]).join(" + ")}`)

  if (result.provider === "laya") {
    log.message(layaNextSteps(result))
    outro("Without a valid calibrated policy, auto-approval stays off; host prompts remain in control")

    return
  }

  outro(`Jevvy is ready for ${result.harnesses.map((harness) => harnessLabels[harness]).join(", ")}`)
}

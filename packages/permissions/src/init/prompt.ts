import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Terminal from "effect/Terminal"
import type * as Prompt from "effect/cli/Prompt"
import * as Controls from "./controls.ts"
import { parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { DEFAULT_LAYA_ENDPOINT, DEFAULT_LAYA_MODEL } from "../core.ts"
import { providerDisplayName, providerSetupChoices } from "../providers.ts"
import type { InitHarness, InitPlan, InitProvider, InitResult } from "./index.ts"
import { showInitSection } from "./theme.ts"

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

type ProviderPrompts = {
  readonly text: (options: Controls.TextOptions) => Effect.Effect<string, Terminal.QuitError, Prompt.Environment>
  readonly confirm: (options: Controls.ConfirmOptions) => Effect.Effect<boolean, Terminal.QuitError, Prompt.Environment>
  readonly password: (options: Controls.TextOptions) => Effect.Effect<Redacted.Redacted<string>, Terminal.QuitError, Prompt.Environment>
}

type LayaPrompts = ProviderPrompts & {
  readonly select: (options: Controls.SelectOptions<LayaCheckpoint>) => Effect.Effect<LayaCheckpoint, Terminal.QuitError, Prompt.Environment>
}

const layaPrompts: LayaPrompts = Controls

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
  message: "Which harnesses should use Jevvy Permissions?",
  choices: [
    { value: "opencode" as const, title: harnessLabels.opencode, description: "permission plugin", selected: true },
    { value: "claude" as const, title: harnessLabels.claude, description: "PermissionRequest hook", selected: true },
  ],
  min: 1,
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

export const microsoftEndpointError = (value: string | undefined): string | undefined => {
  const error = endpointError(value)

  if (error !== undefined) return error

  const endpoint = new URL(value ?? "")

  if (endpoint.protocol !== "https:") return "Use an https:// Foundry endpoint to protect your Azure API key"

  return endpoint.username !== "" || endpoint.password !== ""
    ? "Use the API key field instead of URL credentials"
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

export const showInitCancelled = showInitSection("Jevvy Permissions setup cancelled")

const validate = (check: (value: string) => string | undefined) => (value: string): Effect.Effect<string, string> => {
  const error = check(value)

  return error === undefined ? Effect.succeed(value) : Effect.fail(error)
}

const promptApiKey = (
  message: string,
  askPassword: LayaPrompts["password"] = Controls.password,
) => askPassword({ message, validate: validate(required) })

export const promptMicrosoftProvider = Effect.fn("Init.promptMicrosoftProvider")(function*(
  prompts: Pick<ProviderPrompts, "text" | "password"> = Controls,
): Effect.fn.Return<Extract<InitProvider, { provider: "microsoft" }>, Terminal.QuitError, Prompt.Environment> {
  const endpoint = yield* prompts.text({
    message: "Foundry inference URL (https://RESOURCE.services.ai.azure.com/providers/microsoft/v1/systemone)",
    validate: validate(microsoftEndpointError),
  })

  const model = yield* prompts.text({
    message: "Microsoft-Decision-1 deployment name",
    validate: validate(required),
  })

  const apiKey = yield* promptApiKey("Enter your Azure AI API key", prompts.password)

  return { provider: "microsoft", endpoint: endpoint.trim(), model: model.trim(), apiKey }
})

export const promptLayaProvider = Effect.fn("Init.promptLayaProvider")(function*(
  prompts: LayaPrompts = layaPrompts,
  defaults: LayaPromptDefaults = {},
): Effect.fn.Return<Extract<InitProvider, { provider: "laya" }>, Terminal.QuitError, Prompt.Environment> {
  const endpoint = yield* prompts.text({
    message: defaults.urlNeedsReentry
      ? "Laya System One URL (re-enter URL with private parameters)"
      : "Laya System One URL",
    default: defaults.endpoint ?? DEFAULT_LAYA_ENDPOINT,
    validate: validate(layaEndpointError),
  })

  const checkpoints: readonly Controls.Choice<LayaCheckpoint>[] = [
    { value: "english", title: "English" },
    { value: "multilingual", title: "Multilingual" },
    { value: "typed-decisions", title: "Typed decisions" },
  ]

  const initial = defaults.model ?? DEFAULT_LAYA_MODEL

  const model = yield* prompts.select({
    message: "Laya checkpoint",
    choices: [...checkpoints.filter(({ value }) => value === initial), ...checkpoints.filter(({ value }) => value !== initial)],
  })

  const hasApiKey = yield* prompts.confirm({
    message: "Does your Laya server require a Bearer API key?",
    initial: defaults.hasApiKey ?? false,
  })

  const apiKey = hasApiKey
    ? yield* promptApiKey(defaults.hasApiKey ? "Re-enter the Laya API key" : "Enter the Laya API key", prompts.password)
    : undefined

  const selectedEndpoint = endpoint.trim()

  const selection: LayaSelectionDraft = { provider: "laya" }

  if (selectedEndpoint !== DEFAULT_LAYA_ENDPOINT) selection.endpoint = selectedEndpoint

  if (model !== DEFAULT_LAYA_MODEL) selection.model = model

  if (apiKey !== undefined) selection.apiKey = apiKey

  return selection
})

const promptProvider = Effect.fn("Init.promptProvider")(function*(
  provider: ProviderName,
  layaDefaults: LayaPromptDefaults,
): Effect.fn.Return<InitProvider, Terminal.QuitError, Prompt.Environment> {
  if (provider === "laya") return yield* promptLayaProvider(undefined, layaDefaults)

  if (provider === "microsoft") return yield* promptMicrosoftProvider()

  if (provider === "custom") {
    const endpoint = yield* Controls.text({
      message: "System One endpoint (http://127.0.0.1:8080/v1/systemone)",
      validate: validate(endpointError),
    })

    const model = yield* Controls.text({
      message: "Model identifier (for example, typesafe/jev)",
      validate: validate(required),
    })

    const hasApiKey = yield* Controls.confirm({
      message: "Does this endpoint require a Bearer API key?",
      initial: true,
    })

    if (!hasApiKey) {
      return { provider: "custom", endpoint: endpoint.trim(), model: model.trim() }
    }

    const apiKey = yield* promptApiKey("Enter the endpoint API key")

    return { provider: "custom", endpoint: endpoint.trim(), model: model.trim(), apiKey }
  }

  const labels = {
    zen: "OpenCode Zen API key",
    typesafe: "TypeSafe API key",
    openrouter: "OpenRouter API key",
    vercel: "Vercel AI Gateway key",
    openai: "OpenAI API key",
  } as const

  const apiKey = yield* promptApiKey(`Enter your ${labels[provider]}`)

  return { provider, apiKey }
})

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

  if (provider.provider === "custom" || provider.provider === "microsoft") {
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
  ...(plan.provider.apiKey !== undefined
    ? [plan.provider.provider === "microsoft" ? "Azure API key: saved in private config" : "Bearer key: saved in private config"]
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

export const opencodeNextSteps = (): string => [
  "To enable shell review, add this rule to OpenCode's permissions before specific shell rules:",
  '{ "action": "shell", "resource": "*", "effect": "ask" }',
  "Existing allow and deny stay final; specific asks stay human-only. Last matching rule wins.",
  "Without this rule, default-allowed shell commands are not reviewed by Jevvy.",
  "Reload OpenCode after updating permissions.",
].join("\n")

export const promptInitPlan = Effect.fn("Init.promptPlan")(function*(configPath: string, existing?: string) {
  yield* showInitSection("Set up Jevvy Permissions", "Choose your coding agents and provider.\nCtrl+C cancels a prompt.")

  const harnesses = yield* Controls.multiSelect<InitHarness>(harnessPrompt)

  const providerName = yield* Controls.searchableSelect<ProviderName>({
    message: "Which decision provider should Jevvy use?",
    choices: providerSetupChoices,
  })

  const provider = yield* promptProvider(providerName, layaPromptDefaults(existing))
  const plan = { harnesses, provider }
  yield* showInitSection("Review setup", initPlanSummary(plan, configPath))

  if (provider.provider === "laya") {
    yield* showInitSection("Laya policy", "Laya needs a checkpoint-specific policy; without one, auto-approval stays off.")
  }

  if (provider.provider === "openai" || provider.provider === "microsoft") {
    yield* showInitSection("Model calibration", decisionModelCalibrationWarning)
  }

  const accepted = yield* Controls.confirm({
    message: "Save config and install integrations?",
    initial: true,
  })

  if (!accepted) {
    yield* showInitCancelled

    return undefined
  }

  return plan
})

export const showInitProgress = showInitSection("Saving config and installing integrations")

export const confirmInitWarning = Effect.fn("Init.confirmWarning")(function*(message: string) {
  yield* showInitSection("Compatibility warning", message)
  const answer = yield* Controls.confirm({ message: "Continue with this OpenCode CLI anyway?", initial: false })

  if (!answer) yield* showInitCancelled

  return answer
})

export const showInitError = (message: string) => showInitSection("Jevvy Permissions setup did not complete", message)

export const decisionModelCalibrationWarning = "Jevvy's default questions and thresholds are calibrated for Jev, not this model. Calibrate your policy for this model before relying on auto-approval. Set permissions.questions in your global config; the optional calibrate-permissions skill can help."

export const showInitResult = Effect.fn("Init.showResult")(function*(result: InitResult) {
  yield* showInitSection(`Installed Jevvy Permissions in ${result.harnesses.map((harness) => harnessLabels[harness]).join(" + ")}`)

  if (result.harnesses.includes("opencode")) yield* showInitSection("OpenCode permission review", opencodeNextSteps())

  if (result.provider === "laya") {
    yield* showInitSection("Next steps for Laya", layaNextSteps(result))
    yield* showInitSection("Host prompts remain in control", "Without a valid calibrated policy, auto-approval stays off")

    return
  }

  yield* showInitSection(`Jevvy Permissions is ready for ${result.harnesses.map((harness) => harnessLabels[harness]).join(", ")}`)
})

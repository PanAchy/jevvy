import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  password,
  select,
  text,
} from "@clack/prompts"
import { Redacted } from "effect"
import { providerDisplayName } from "../providers.ts"
import type { InitHarness, InitPlan, InitProvider, InitResult } from "./index.ts"

type ProviderName = InitProvider["provider"]

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

const endpointError = (value: string | undefined): string | undefined => {
  const missing = required(value)

  if (missing !== undefined) return missing

  try {
    const endpoint = new URL(value ?? "")

    return endpoint.protocol === "http:" || endpoint.protocol === "https:"
      ? undefined
      : "Use an http:// or https:// endpoint"
  } catch {
    return "Enter a valid endpoint URL"
  }
}

const stop = (): undefined => {
  cancel("Jevvy setup cancelled")

  return undefined
}

const promptApiKey = async (message: string): Promise<Redacted.Redacted<string> | undefined> => {
  const answer = await password({ message, validate: required })

  return isCancel(answer) ? undefined : Redacted.make(answer)
}

const promptProvider = async (
  provider: ProviderName,
): Promise<InitProvider | undefined> => {
  if (provider === "custom") {
    const endpoint = await text({
      message: "System One endpoint",
      placeholder: "http://127.0.0.1:8080/v1/decisions",
      validate: endpointError,
    })

    if (isCancel(endpoint)) return undefined

    const model = await text({
      message: "Model identifier",
      placeholder: "typesafe/jev",
      validate: required,
    })

    if (isCancel(model)) return undefined

    const hasApiKey = await confirm({
      message: "Does this endpoint require a Bearer API key?",
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

export const initPlanSummary = (plan: InitPlan, configPath: string): string => [
  `Harnesses: ${plan.harnesses.map((harness) => harnessLabels[harness]).join(", ")}`,
  `Provider: ${providerDisplayName(plan.provider.provider)}`,
  `Configuration: ${configPath}`,
  plan.provider.apiKey !== undefined
    ? "Credential: stored securely in config"
    : "Credential: not required by endpoint",
].join("\n")

export const promptInitPlan = async (configPath: string): Promise<InitPlan | undefined> => {
  intro("Set up Jevvy")

  const harnesses = await multiselect<InitHarness>(harnessPrompt)

  if (isCancel(harnesses)) return stop()

  const providerName = await select<ProviderName>({
    message: "Which System One provider should Jevvy use?",
    options: [
      { value: "zen", label: providerDisplayName("zen") },
      { value: "typesafe", label: providerDisplayName("typesafe") },
      { value: "openrouter", label: providerDisplayName("openrouter") },
      { value: "vercel", label: providerDisplayName("vercel") },
      { value: "custom", label: providerDisplayName("custom"), hint: "any System One-compatible server" },
    ],
  })

  if (isCancel(providerName)) return stop()

  const provider = await promptProvider(providerName)

  if (provider === undefined) return stop()

  note(initPlanSummary({ harnesses, provider }, configPath), "Setup plan")

  const accepted = await confirm({ message: "Apply this setup?", initialValue: true })

  if (isCancel(accepted) || !accepted) return stop()

  return { harnesses, provider }
}

export const showInitProgress = (): void => log.step("Writing configuration and installing harnesses")

export const showInitError = (message: string): void => {
  log.error(message)
  outro("Jevvy setup did not complete")
}

export const showInitResult = (result: InitResult): void => {
  log.success(`Configured ${providerDisplayName(result.provider)} in ${result.configPath}`)

  outro(`Jevvy is ready for ${result.harnesses.map((harness) => harnessLabels[harness]).join(", ")}`)
}

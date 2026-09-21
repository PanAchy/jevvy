import { Effect } from "effect"
import { globalJevvyConfigPath, loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import type { PermissionReviewer } from "../engine.ts"
import {
  createConfiguredProvider,
  providerApiKeyEnvironment,
  providerDisplayName,
} from "../providers.ts"
import type { BuiltInProvider } from "../providers.ts"
import { createClaudeEvaluate, decodeClaudeHookEvent, setupUnavailableOutput } from "./evaluate.ts"

export type ClaudeReviewerSetup =
  | { readonly kind: "ready"; readonly reviewer: PermissionReviewer }
  | { readonly kind: "unavailable"; readonly message: string }

export type ClaudeSetupLoader<E> = () => Effect.Effect<ClaudeReviewerSetup, E>

const setupWarning = (summary: string, actions: readonly string[]): string => [
  "\n⚠ Jevvy setup required!",
  "",
  summary,
  ...actions,
  "",
  "Claude Code permissions are unchanged.",
].join("\n")

export const missingClaudeConfigurationMessage = (configPath: string): string =>
  setupWarning("Auto-approval is off because no provider is configured.", [
    "Run: npx @jevvy/permissions init",
    `Or configure ${configPath} manually.`,
  ])

export const missingClaudeCredentialMessage = (provider: BuiltInProvider, configPath: string): string =>
  setupWarning(`Auto-approval is off because ${providerDisplayName(provider)} has no credential available to Claude Code.`, [
    `Set ${providerApiKeyEnvironment(provider)} or add providers.${provider}.apiKey to ${configPath}.`,
    "Or run: npx @jevvy/permissions init",
  ])

export const loadClaudeSetup = Effect.fn("ClaudeCode.loadSetup")(function*() {
  const configPath = globalJevvyConfigPath()
  const config = yield* loadJevvyConfig(configPath)

  if (config.kind === "invalid") {
    return {
      kind: "unavailable",
      message: setupWarning(`Auto-approval is off because ${configPath} is invalid: ${config.message}.`, [
        "Fix the file, or move it aside and run: npx @jevvy/permissions init",
      ]),
    } as const
  }

  if (config.kind === "unconfigured") {
    return { kind: "unavailable", message: missingClaudeConfigurationMessage(configPath) } as const
  }

  const selected = createConfiguredProvider(config.selection)

  if (selected === undefined) {
    if (config.selection.provider === "custom") {
      return {
        kind: "unavailable",
        message: setupWarning(`Auto-approval is off because the custom provider could not be initialized from ${configPath}.`, [
          "Fix the file, or run: npx @jevvy/permissions init",
        ]),
      } as const
    }

    return {
      kind: "unavailable",
      message: missingClaudeCredentialMessage(config.selection.provider, configPath),
    } as const
  }

  const reviewer = config.kind === "custom-policy"
    ? yield* createPermissionReviewer(selected.client, { questions: config.questions })
    : yield* createPermissionReviewer(selected.client)

  return { kind: "ready", reviewer } as const
})

export const createClaudeHookHandler = <E>(
  loadSetup: ClaudeSetupLoader<E>,
): ((raw: string) => Effect.Effect<string | undefined>) =>
  Effect.fn("ClaudeCode.handleHookEvent")(function*(raw) {
    const event = decodeClaudeHookEvent(raw)

    if (event === undefined) return undefined

    const setup = yield* loadSetup().pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (loaded) => loaded,
      }),
    )

    if (setup === undefined) return undefined

    if (event.hook_event_name === "SessionStart") {
      return setup.kind === "unavailable"
        ? JSON.stringify(setupUnavailableOutput(setup.message))
        : undefined
    }

    if (setup.kind === "unavailable") return undefined

    const output = yield* createClaudeEvaluate(setup.reviewer)(event)

    return output === undefined ? undefined : JSON.stringify(output)
  })

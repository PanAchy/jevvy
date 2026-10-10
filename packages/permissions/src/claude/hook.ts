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
import { hasHostAsk, loadAskRules } from "./ask-rules.ts"
import { createClaudeEvaluate, decodeClaudeHookEvent, sessionStartOutput } from "./evaluate.ts"
import type { ClaudeHookOutput } from "./evaluate.ts"
import { withReviewEnabled } from "../review-control.ts"
import type { ReviewControl } from "../review-control.ts"

export type ClaudeReviewerSetup =
  | { readonly kind: "ready"; readonly reviewer: PermissionReviewer }
  | { readonly kind: "unavailable"; readonly message: string }

export type ClaudeSetupLoader<E> = () => Effect.Effect<ClaudeReviewerSetup, E>

export type ClaudeAskLoader = (cwd: string) => Effect.Effect<readonly string[] | undefined>

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

export const invalidClaudeConfigurationMessage = (configPath: string, detail: string): string =>
  setupWarning(`Auto-approval is off because ${configPath} is invalid: ${detail}.`, [
    "Fix the file before enabling auto-approval.",
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
      message: invalidClaudeConfigurationMessage(configPath, config.message),
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
  loadAsks: ClaudeAskLoader = loadAskRules,
  control?: Pick<ReviewControl, "read">,
): ((raw: string) => Effect.Effect<ClaudeHookOutput | undefined>) =>
  Effect.fn("ClaudeCode.handleHookEvent")(function*(raw) {
    const event = decodeClaudeHookEvent(raw)

    if (event === undefined) return undefined

    const review = Effect.gen(function*() {
      if (event.hook_event_name === "PermissionRequest") {
        const asks = yield* loadAsks(event.cwd)

        if (asks === undefined || hasHostAsk(event.tool_input.command, asks)) return undefined
      }

      const setup = yield* loadSetup().pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (loaded) => loaded,
        }),
      )

      if (setup === undefined) return undefined

      if (event.hook_event_name === "SessionStart") {
        return sessionStartOutput(setup.kind === "unavailable" ? setup.message : undefined)
      }

      if (setup.kind === "unavailable") return undefined

      return yield* createClaudeEvaluate(setup.reviewer)(event)
    })

    if (event.hook_event_name === "PermissionRequest" && control !== undefined) {
      return yield* withReviewEnabled(control, "claude", review)
    }

    return yield* review
  })

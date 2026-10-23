import * as Effect from "effect/Effect"
import { globalJevvyConfigPath, loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import type { PermissionReviewer } from "../engine.ts"
import {
  createConfiguredProvider,
  providerApiKeyEnvironment,
  providerDisplayName,
} from "../providers.ts"
import type { BuiltInProvider } from "../providers.ts"
import { hasHostAsk } from "./ask-rules.ts"
import { createClaudeEvaluate, decodeClaudeHookEvent, sessionStartOutput } from "./evaluate.ts"
import type { ClaudeHookOutput } from "./evaluate.ts"
import { withReviewEnabled } from "../review-control.ts"
import type { ReviewControl } from "../review-control.ts"

export type ClaudeReviewerSetup =
  | { readonly kind: "ready"; readonly reviewer: PermissionReviewer; readonly reviewAskPatterns: readonly string[] }
  | { readonly kind: "unavailable"; readonly message: string }

export type ClaudeSetupLoader<E, R = never> = () => Effect.Effect<ClaudeReviewerSetup, E, R>

export type ClaudeAskLoader<R = never> = (cwd: string) => Effect.Effect<readonly string[] | undefined, never, R>

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

  const reviewer = yield* createPermissionReviewer(selected.client, {
    questions: config.kind === "custom-policy" ? config.questions : undefined,
    timeoutMs: config.timeoutMs,
  })

  return { kind: "ready", reviewer, reviewAskPatterns: config.reviewAskPatterns.claude } as const
})

export const createClaudeHookHandler = <E, R, AsksR>(
  loadSetup: ClaudeSetupLoader<E, R>,
  loadAsks: ClaudeAskLoader<AsksR>,
  control?: Pick<ReviewControl, "read">,
): ((raw: string) => Effect.Effect<ClaudeHookOutput | undefined, never, R | AsksR>) =>
  Effect.fn("ClaudeCode.handleHookEvent")(function*(raw) {
    const event = decodeClaudeHookEvent(raw)

    if (event === undefined) return undefined

    const review = Effect.gen(function*() {
      const asks = event.hook_event_name === "PermissionRequest" ? yield* loadAsks(event.cwd) : []

      if (asks === undefined) return undefined

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

      if (hasHostAsk(event.tool_input.command, asks, setup.reviewAskPatterns)) return undefined

      return yield* createClaudeEvaluate(setup.reviewer)(event)
    })

    if (event.hook_event_name === "PermissionRequest" && control !== undefined) {
      return yield* withReviewEnabled(control, "claude", review)
    }

    return yield* review
  })

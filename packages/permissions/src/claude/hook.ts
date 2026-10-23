import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import type * as Scope from "effect/Scope"
import { globalJevvyConfigPath, loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import type { PermissionReviewer } from "../engine.ts"
import {
  createConfiguredProvider,
  providerApiKeyEnvironment,
  providerDisplayName,
} from "../providers.ts"
import type { BuiltInProvider } from "../providers.ts"
import { inspectAskEligibility } from "./ask-rules.ts"
import { decodeClaudeHookEvent, permissionAllowOutput, sessionStartOutput } from "./evaluate.ts"
import type { HistoryObserver } from "../history.ts"
import { observeReview } from "../history.ts"
import type { JevProvider } from "../core.ts"
import type { ClaudeHookOutput } from "./evaluate.ts"
import { withReviewEnabled } from "../review-control.ts"
import type { ReviewControl } from "../review-control.ts"

export type ClaudeReviewerSetup =
  | { readonly kind: "ready"; readonly reviewer: PermissionReviewer }
  | { readonly kind: "unavailable"; readonly message: string }

export type ClaudeConfigurationLoader<C, E, R = never> = () => Effect.Effect<
  { readonly kind: "configured"; readonly reviewAskPatterns: readonly string[]; readonly configuration: C; readonly history?: ClaudeHistoryConfiguration }
  | { readonly kind: "unavailable"; readonly message: string }, E, R>

export type ClaudeAskLoader<R = never> = (cwd: string) => Effect.Effect<readonly string[] | undefined, never, R>

export interface ClaudeHistoryConfiguration {
  readonly enabled: boolean
  readonly configPath: string
  readonly provider: JevProvider
}

export type ClaudeHistoryLoader = (configuration: ClaudeHistoryConfiguration) => Effect.Effect<HistoryObserver | undefined, never, Scope.Scope>

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

export const loadClaudeConfiguration = Effect.fn("ClaudeCode.loadConfiguration")(function*() {
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

  return {
    kind: "configured",
    reviewAskPatterns: config.reviewAskPatterns.claude,
    configuration: { config, configPath },
    history: { enabled: config.historyEnabled, configPath, provider: config.selection.provider },
  } as const
})

export const acquireClaudeReviewer = Effect.fn("ClaudeCode.acquireReviewer")(function*(
  { config, configPath }: Extract<Effect.Success<ReturnType<typeof loadClaudeConfiguration>>, { kind: "configured" }>["configuration"],
) {
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

  return { kind: "ready", reviewer } as const
})

export const createClaudeHookHandler = <C, E, R, ReviewerE, ReviewerR, AsksR>(
  loadConfiguration: ClaudeConfigurationLoader<C, E, R>,
  acquireReviewer: (configuration: C) => Effect.Effect<ClaudeReviewerSetup, ReviewerE, ReviewerR>,
  loadAsks: ClaudeAskLoader<AsksR>,
  control?: Pick<ReviewControl, "read">,
  loadHistory?: ClaudeHistoryLoader,
  checkHistory?: (configuration: ClaudeHistoryConfiguration) => Effect.Effect<string | undefined>,
): ((raw: string) => Effect.Effect<ClaudeHookOutput | undefined, never, R | ReviewerR | AsksR>) =>
  Effect.fn("ClaudeCode.handleHookEvent")(function*(raw) {
    const event = decodeClaudeHookEvent(raw)

    if (event === undefined) return undefined

    const review = Effect.scoped(Effect.gen(function*() {
      const asks = event.hook_event_name === "PermissionRequest" ? yield* loadAsks(event.cwd) : []

      if (asks === undefined) return undefined

      const loaded = yield* loadConfiguration().pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (loaded) => loaded,
        }),
      )

      if (loaded === undefined) return undefined

      const eligibility = loaded.kind === "configured" && event.hook_event_name === "PermissionRequest"
        ? inspectAskEligibility(event.tool_input.command, asks, loaded.reviewAskPatterns)
        : "review"

      if (eligibility === "unreliable") return undefined

      const historyConfig = loaded.kind === "configured" ? loaded.history : undefined

      const observer = event.hook_event_name === "PermissionRequest" && historyConfig?.enabled === true && loadHistory !== undefined
        ? yield* Effect.suspend(() => loadHistory(historyConfig)).pipe(
          Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => Effect.succeed(undefined)),
        )
        : undefined

      const history = observer !== undefined && historyConfig !== undefined ? { observer, provider: historyConfig.provider } : undefined

      if (eligibility === "host-ask") {
        if (event.hook_event_name === "PermissionRequest") {
          yield* observeReview(event.tool_input.command, Effect.succeed("explicit-ask" as const), history)
        }

        return undefined
      }

      const setup = loaded.kind === "unavailable" ? loaded : yield* acquireReviewer(loaded.configuration).pipe(
        Effect.match({ onFailure: () => undefined, onSuccess: (ready) => ready }),
      )

      if (setup === undefined) return undefined

      if (event.hook_event_name === "SessionStart") {
        const historyProblem = historyConfig?.enabled === true && checkHistory !== undefined ? yield* checkHistory(historyConfig) : undefined
        const messages = [setup.kind === "unavailable" ? setup.message : undefined, historyProblem].filter((message) => message !== undefined)

        return sessionStartOutput(messages.length === 0 ? undefined : messages.join("\n\n"))
      }

      if (setup.kind === "unavailable") return undefined

      const result = yield* observeReview(event.tool_input.command,
        setup.reviewer.review({ action: "shell", resources: [event.tool_input.command] }), history)

      return result.effect === "allow" ? permissionAllowOutput : undefined
    }))

    if (event.hook_event_name === "PermissionRequest" && control !== undefined) {
      return yield* withReviewEnabled(control, "claude", review)
    }

    return yield* review
  })

// The OpenCode V2 Effect plugin - thin shim around the agnostic core.

import { Config, Effect, Option, Redacted } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import { config as loadEnv } from "dotenv"
import { classifyCodeTiers } from "../core/floor.ts"
import { createJudge } from "../core/judge.ts"
import type { JevJudge } from "../core/judge.ts"
import { combine, defaultThresholds } from "../core/decision.ts"
import type { CommandInput, Thresholds, Verdict } from "../core/decision.ts"

export interface PluginOptions {
  readonly model?: string
  readonly thresholds?: Partial<Thresholds>
  /** Log verdicts without applying them - adoption safety. */
  readonly dryRun?: boolean
  /** Disable the persistent decision log. */
  readonly noLog?: boolean
}

// Boundary parsing: every typeof lives inside a named type predicate, so each
// check establishes a contract instead of narrowing raw representations.

interface UserMessage {
  readonly type?: unknown
  readonly role?: unknown
  readonly parts: readonly unknown[]
}

const isUserMessage = (u: unknown): u is UserMessage =>
  typeof u === "object" &&
  u !== null &&
  "parts" in u &&
  Array.isArray(u.parts) &&
  (("type" in u && u.type === "user") || ("role" in u && u.role === "user"))

interface TextPart {
  readonly text: string
}

const isTextPart = (u: unknown): u is TextPart =>
  typeof u === "object" && u !== null && "text" in u && typeof u.text === "string"

const isString = (u: unknown): u is string => typeof u === "string"

const isBoolean = (u: unknown): u is boolean => typeof u === "boolean"

const isNumber = (u: unknown): u is number => typeof u === "number"

interface PluginOptionsInput {
  readonly model?: unknown
  readonly thresholds?: unknown
  readonly dryRun?: unknown
  readonly noLog?: unknown
}

const isPluginOptionsInput = (u: unknown): u is PluginOptionsInput => typeof u === "object" && u !== null

interface ThresholdsInput {
  readonly highRisk?: unknown
  readonly ask?: unknown
  readonly allow?: unknown
  readonly authorized?: unknown
}

const isThresholdsInput = (u: unknown): u is ThresholdsInput => typeof u === "object" && u !== null

/** Mutable staging type for parsed options before they are frozen as PluginOptions. */
interface MutablePluginOptions {
  model?: string
  thresholds?: Partial<Thresholds>
  dryRun?: boolean
  noLog?: boolean
}

/** Mutable staging type for threshold overrides picked off raw config. */
interface MutableThresholdOverrides {
  highRisk?: number
  ask?: number
  allow?: number
  authorized?: number
}

/** Thresholds with readonly stripped, so defaults can be overridden in place. */
type MutableThresholds = { -readonly [K in keyof Thresholds]: Thresholds[K] }

const parseOptions = (raw: PluginOptionsInput): PluginOptions => {
  const options: MutablePluginOptions = {}

  if (isString(raw.model)) options.model = raw.model

  if (isBoolean(raw.dryRun)) options.dryRun = raw.dryRun

  if (isBoolean(raw.noLog)) options.noLog = raw.noLog

  if (isThresholdsInput(raw.thresholds)) {
    const record = raw.thresholds
    const partial: MutableThresholdOverrides = {}

    if (isNumber(record.highRisk)) partial.highRisk = record.highRisk

    if (isNumber(record.ask)) partial.ask = record.ask

    if (isNumber(record.allow)) partial.allow = record.allow

    if (isNumber(record.authorized)) partial.authorized = record.authorized

    if (partial.highRisk !== undefined || partial.ask !== undefined || partial.allow !== undefined || partial.authorized !== undefined) {
      options.thresholds = partial
    }
  }

  return options
}

/** Defensive extraction of the latest user text from session context. */
const extractTask = (messages: readonly unknown[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (!isUserMessage(message)) continue

    const texts: string[] = []

    for (const part of message.parts) {
      if (isTextPart(part) && part.text.length > 0) texts.push(part.text)
    }

    const joined = texts.join("\n").trim()

    if (joined.length > 0) return joined
  }

  return undefined
}

export default Plugin.define({
  id: "jevvy",
  effect: (ctx) =>
    Effect.gen(function* () {
      const project = ctx.location.directory
      const options = isPluginOptionsInput(ctx.options) ? parseOptions(ctx.options) : {}

      // Step-wise threshold assembly: defaults, then any explicit overrides.
      const thresholds: MutableThresholds = { ...defaultThresholds }
      const overrides = options.thresholds

      if (overrides !== undefined) {
        if (overrides.highRisk !== undefined) thresholds.highRisk = overrides.highRisk

        if (overrides.ask !== undefined) thresholds.ask = overrides.ask

        if (overrides.allow !== undefined) thresholds.allow = overrides.allow

        if (overrides.authorized !== undefined) thresholds.authorized = overrides.authorized
      }

      const dryRun = options.dryRun === true

      // dotenv runs once at the adapter edge; Config is the only reader of the
      // environment from here on. Option-wrapped: a missing key means "code
      // tiers only", never a failed plugin load.
      loadEnv({ path: `${project}/.env`, quiet: true })
      const apiKey = yield* Config.option(Config.redacted("TYPESAFE_API_KEY")).pipe(Effect.orDie)

      if (Option.isNone(apiKey)) {
        yield* Effect.logWarning("[jevvy] TYPESAFE_API_KEY not set - plugin inert, code tiers only")
      }

      const judge: JevJudge | undefined = Option.isSome(apiKey)
        ? createJudge(Redacted.value(apiKey.value), options.model)
        : undefined

      yield* Effect.logInfo("[jevvy] loaded", { project, dryRun, model: options.model ?? "jev-1.13.0" })

      const logDecision = (sessionID: string, command: string, verdict: Verdict): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (options.noLog === true) return

          const entry = {
            time: new Date().toISOString(),
            sessionID,
            command: command.slice(0, 500),
            effect: verdict.effect,
            source: verdict.source,
            reason: verdict.reason,
            judged: verdict.judged,
          }

          const previous = yield* ctx.storage.get("decisions").pipe(Effect.orDie)
          const history = Array.isArray(previous) ? previous : []
          yield* ctx.storage.set("decisions", [...history, entry].slice(-200)).pipe(Effect.orDie)
        })

      yield* ctx.permission.hook("evaluate", (event) =>
        Effect.gen(function* () {
          if (event.action !== "shell") return

          const command = event.resources.join(" ; ")

          // 1. Code tiers - deterministic, private, free.
          const tier = classifyCodeTiers(command)

          if (tier.tier === "floor") {
            const verdict: Verdict = {
              effect: "ask",
              reason: `jevvy floor: ${tier.reason} - certain danger, please look closely`,
              source: "floor",
            }

            if (!dryRun) {
              event.effect = verdict.effect
              event.message = verdict.reason
            }

            yield* Effect.logInfo("[jevvy] floor ask", { command: command.slice(0, 160), reason: tier.reason })
            yield* logDecision(event.sessionID, command, verdict)

            return
          }

          if (tier.tier === "credential") {
            const verdict: Verdict = {
              effect: "ask",
              reason: `jevvy: ${tier.reason} - not sent to the model`,
              source: "credential",
            }

            if (!dryRun) {
              event.effect = verdict.effect
              event.message = verdict.reason
            }

            yield* Effect.logInfo("[jevvy] credential ask", { command: command.slice(0, 160), reason: tier.reason })
            yield* logDecision(event.sessionID, command, verdict)

            return
          }

          if (tier.tier === "proven") {
            const verdict: Verdict = { effect: "allow", reason: `jevvy: ${tier.reason}`, source: "proven" }

            if (!dryRun) {
              event.effect = verdict.effect
              event.message = verdict.reason
            }

            yield* Effect.logInfo("[jevvy] proven allow", { command: command.slice(0, 160) })
            yield* logDecision(event.sessionID, command, verdict)

            return
          }

          // 2. No judge configured (no API key) - stay out of the way.
          if (judge === undefined) return

          // 3. Jev - one call, risk + context axes together. Fail closed.
          const task = yield* ctx.session.context({ sessionID: event.sessionID }).pipe(
            Effect.orDie,
            Effect.map((messages) => extractTask(messages)),
          )

          const input: CommandInput = { command, cwd: project, task }

          const judged = yield* Effect.tryPromise(() => judge.judge(input)).pipe(
            Effect.timeout(5000),
            Effect.catch((error) =>
              Effect.logWarning("[jevvy] judge unavailable", { error: String(error) }).pipe(Effect.as(null)),
            ),
          )

          const verdict: Verdict =
            judged === null
              ? {
                  effect: "ask",
                  reason: "jevvy: judgment unavailable - failing closed",
                  source: "failclosed",
                }
              : combine(input, judged, thresholds)

          if (!dryRun) {
            event.effect = verdict.effect

            if (verdict.effect !== "allow") event.message = verdict.reason
          }

          yield* Effect.logInfo("[jevvy] verdict", {
            command: command.slice(0, 160),
            effect: verdict.effect,
            source: verdict.source,
          })
          yield* logDecision(event.sessionID, command, verdict)
        }),
      )
    }),
})

// The OpenCode V2 Effect plugin — thin shim around the agnostic core.

import { Effect } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import { config as loadEnv } from "dotenv"
import { classifyCodeTiers } from "../core/floor.ts"
import { makeJudge } from "../core/judge.ts"
import type { JevJudge } from "../core/judge.ts"
import { combine, defaultThresholds } from "../core/decision.ts"
import type { CommandInput, Thresholds, Verdict } from "../core/decision.ts"

export interface PluginOptionsShape {
  readonly model?: string
  readonly thresholds?: Partial<Thresholds>
  /** Log verdicts without applying them — adoption safety. */
  readonly dryRun?: boolean
  /** Disable the persistent decision log. */
  readonly noLog?: boolean
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null

/** Defensive extraction of the latest user text from session context. */
const extractTask = (messages: readonly unknown[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (!isRecord(message) || message.role !== "user") continue
    const parts = Array.isArray(message.parts) ? message.parts : []
    const texts: string[] = []

    for (const part of parts) {
      if (isRecord(part) && typeof part.text === "string" && part.text.length > 0) texts.push(part.text)
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
      const options: PluginOptionsShape = isRecord(ctx.options) ? ctx.options : {}

      const thresholds: Thresholds = {
        ...defaultThresholds,
        ...(isRecord(options.thresholds) ? (options.thresholds as Partial<Thresholds>) : {}),
      }

      const dryRun = options.dryRun === true

      loadEnv({ path: `${project}/.env`, quiet: true })
      const apiKey = process.env.TYPESAFE_API_KEY

      if (!apiKey) {
        yield* Effect.logWarning("[jevvy] TYPESAFE_API_KEY not set — plugin inert, code tiers only")
      }

      const judge: JevJudge | undefined = apiKey ? makeJudge(apiKey, options.model) : undefined

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

          // 1. Code tiers — deterministic, private, free.
          const tier = classifyCodeTiers(command)

          if (tier.tier === "floor") {
            const verdict: Verdict = {
              effect: "ask",
              reason: `jevvy floor: ${tier.reason} — certain danger, please look closely`,
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
              reason: `jevvy: ${tier.reason} — not sent to the model`,
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

          // 2. No judge configured (no API key) — stay out of the way.
          if (judge === undefined) return

          // 3. Jev — one call, risk + context axes together. Fail closed.
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
                  reason: "jevvy: judgment unavailable — failing closed",
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

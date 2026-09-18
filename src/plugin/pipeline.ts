// The permission evaluate pipeline: code tiers first, then the judge, then
// the policy. Testable without the plugin SDK through a structural event type.

import { Effect, Option } from "effect"
import { classifyCodeTiers } from "../core/floor.ts"
import { combine } from "../core/decision.ts"
import type { CommandInput, Thresholds, Verdict } from "../core/decision.ts"
import { JudgeService } from "./judge.ts"
import type { DecisionLog } from "./log.ts"

/** Structural subset of OpenCode's PermissionEvaluation; the SDK event is a
 *  richer object and assigns to this. */
export interface EvaluationEvent {
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  effect: "allow" | "ask" | "deny"
  message?: string
}

export interface PipelineConfig {
  readonly thresholds: Thresholds
  readonly dryRun: boolean
  readonly notePerAllow: boolean
}

export interface PipelineHost {
  readonly project: string
  readonly sessionTask: (sessionID: string) => Effect.Effect<string | undefined>
  readonly log: DecisionLog
  /** Posts a note into the session. Wired to session.synthetic by the host. */
  readonly note: (sessionID: string, text: string) => Effect.Effect<void>
}

// Session context is foreign data: every typeof lives inside a named type
// predicate, so each check establishes a contract.

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

/** Latest user text from session context, newest message first. */
export const extractTask = (messages: readonly unknown[]): string | undefined => {
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

export const createEvaluate = (
  config: PipelineConfig,
  host: PipelineHost,
): Effect.Effect<(event: EvaluationEvent) => Effect.Effect<void>, never, JudgeService> =>
  Effect.gen(function* () {
    const judge = yield* JudgeService

    const applyVerdict = (event: EvaluationEvent, verdict: Verdict): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!config.dryRun) {
          event.effect = verdict.effect
          event.message = verdict.reason
        }

        yield* Effect.logInfo("[jevvy] verdict", {
          effect: verdict.effect,
          source: verdict.source,
          command: event.resources.join(" ; ").slice(0, 160),
        })
        yield* host.log.append(event.sessionID, event.resources.join(" ; "), verdict)
      })

    return (event) =>
      Effect.gen(function* () {
        if (event.action !== "shell") return

        // 1. Code tiers - deterministic, private, free.
        const command = event.resources.join(" ; ")
        const tier = classifyCodeTiers(command)

        if (tier.tier === "floor") {
          yield* applyVerdict(event, {
            effect: "ask",
            reason: `jevvy floor: ${tier.reason} - certain danger, please look closely`,
            source: "floor",
          })

          return
        }

        if (tier.tier === "credential") {
          yield* applyVerdict(event, {
            effect: "ask",
            reason: `jevvy: ${tier.reason} - not sent to the model`,
            source: "credential",
          })

          return
        }

        if (tier.tier === "proven") {
          yield* applyVerdict(event, {
            effect: "allow",
            reason: `jevvy: ${tier.reason}`,
            source: "proven",
          })

          return
        }

        // 2. Judge - cached inside the service; None means unavailable and
        // jevvy stays out of the way rather than guessing.
        const task = yield* host.sessionTask(event.sessionID)
        const input: CommandInput = { command, cwd: host.project, task }
        const judged = yield* judge.judge(input)

        if (Option.isNone(judged)) return

        // 3. Policy - plain code over the probabilities.
        const verdict = combine(input, judged.value, config.thresholds)
        yield* applyVerdict(event, verdict)

        // Notes are opt-in: they enter the model's context, so only
        // Jev-derived allows post one, never proven-tier noise.
        if (config.notePerAllow && !config.dryRun && verdict.effect === "allow" && verdict.source === "jev") {
          yield* host.note(event.sessionID, `jevvy allowed \`${command.slice(0, 80)}\`: ${verdict.reason}`)
        }
      })
  })

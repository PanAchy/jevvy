// The permission evaluate pipeline: code tiers first, then the judge, then
// the policy. Testable without the plugin SDK through a structural event type.

import { Effect, Option } from "effect"
import { classifySegments, joinForJudge, redactSecrets } from "../core/floor.ts"
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
  readonly isRememberedApproval: (action: string, resources: readonly string[]) => Effect.Effect<boolean>
  readonly log: DecisionLog
  /** Posts a note into the session. Wired to session.synthetic by the host. */
  readonly note: (sessionID: string, text: string) => Effect.Effect<void>
}

// Session context is foreign data: every typeof lives inside a named type
// predicate, so each check establishes a contract. Shape verified against a
// live context dump: user messages carry top-level `text`, no `parts`.

interface UserTextMessage {
  readonly type?: unknown
  readonly role?: unknown
  readonly text: string
}

const isUserTextMessage = (u: unknown): u is UserTextMessage =>
  typeof u === "object" &&
  u !== null &&
  "text" in u &&
  typeof u.text === "string" &&
  (("type" in u && u.type === "user") || ("role" in u && u.role === "user"))

/** Latest user text from session context, newest message first. */
export const extractTask = (messages: readonly unknown[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (!isUserTextMessage(message)) continue

    const text = message.text.trim()

    if (text.length > 0) return text
  }

  return undefined
}

/** What leaves the machine or lands in plain-text surfaces: redacted, bounded. */
const toExternal = (command: string, limit: number): string => redactSecrets(command).slice(0, limit)

export const createEvaluate = (
  config: PipelineConfig,
  host: PipelineHost,
): Effect.Effect<(event: EvaluationEvent) => Effect.Effect<void>, never, JudgeService> =>
  Effect.gen(function* () {
    const judge = yield* JudgeService

    const applyVerdict = (event: EvaluationEvent, verdict: Verdict, command: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const hostEffect = event.effect

        if (!config.dryRun) {
          event.effect = verdict.effect
          event.message = verdict.reason
        }

        yield* Effect.logInfo("[jevvy] verdict", {
          effect: verdict.effect,
          hostEffect,
          source: verdict.source,
          command: toExternal(command, 160),
        })
        yield* host.log.append(event.sessionID, command, verdict)
      })

    return (event) =>
      Effect.gen(function* () {
        if (event.action !== "shell") return

        // The user is the final authority. OpenCode applies remembered
        // "always" approvals before this hook, so never turn one back into an
        // ask. Require both the host allow and a saved pattern match: ordinary
        // default allows still receive Jevvy review.
        if (event.effect === "allow" && (yield* host.isRememberedApproval(event.action, event.resources))) {
          yield* Effect.logInfo("[jevvy] remembered approval", {
            effect: event.effect,
            command: toExternal(joinForJudge(event.resources), 160),
          })

          return
        }

        // Stripped once, up front: comments cannot steer tiers, the judge,
        // or the log ("nothing a command says about itself can help it").
        // Resources are classified independently (strictest tier wins) so
        // one resource's comment can never hide another's danger; the
        // joined form exists only for the judge and the logs.
        const command = joinForJudge(event.resources)
        const tier = classifySegments(event.resources)

        if (tier.tier === "floor") {
          yield* applyVerdict(event, {
            effect: "ask",
            reason: `jevvy floor: ${tier.reason} - certain danger, please look closely`,
            source: "floor",
          }, command)

          return
        }

        if (tier.tier === "credential") {
          yield* applyVerdict(event, {
            effect: "ask",
            reason: `jevvy: ${tier.reason} - not sent to the model`,
            source: "credential",
          }, command)

          return
        }

        if (tier.tier === "proven") {
          yield* applyVerdict(event, {
            effect: "allow",
            reason: `jevvy: ${tier.reason}`,
            source: "proven",
          }, command)

          return
        }

        // 2. Judge - cached inside the service. None from a degraded judge
        // (no key) means stay out of the way; None from a live judge means
        // fail closed: no judgment, no silent allow. Task text is redacted
        // like the command (pasted secrets in chat must not reach the
        // provider), and only the directory name of the project travels.
        const task = yield* host.sessionTask(event.sessionID)

        const input: CommandInput = {
          command: toExternal(command, 2_000),
          cwd: host.project.split("/").filter(Boolean).pop(),
          task: task === undefined ? undefined : toExternal(task, 1_200),
        }

        const judged = yield* judge.judge(input)

        if (Option.isNone(judged)) {
          if (judge.availability === "live") {
            yield* applyVerdict(
              event,
              { effect: "ask", reason: "jevvy: judgment unavailable - failing closed", source: "failclosed" },
              command,
            )
          }

          return
        }

        // 3. Policy - plain code over the probabilities.
        const verdict = combine(input, judged.value, config.thresholds)
        yield* applyVerdict(event, verdict, command)

        // Notes are opt-in: they enter the model's context, so only
        // Jev-derived allows post one, never proven-tier noise.
        if (config.notePerAllow && !config.dryRun && verdict.effect === "allow" && verdict.source === "jev") {
          yield* host.note(event.sessionID, `jevvy allowed \`${toExternal(command, 80)}\`: ${verdict.reason}`)
        }
      })
  })

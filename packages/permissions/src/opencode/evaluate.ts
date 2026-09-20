import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Effect, Option, Schema } from "effect"
import type { PermissionReviewer } from "../engine.ts"

export interface EvaluationEvent {
  readonly sessionID: string
  readonly action: string
  readonly resources: PermissionEvaluation["resources"]
  readonly metadata?: PermissionEvaluation["metadata"]
  effect: PermissionEvaluation["effect"]
  message?: string
}

const CommandMetadata = Schema.Struct({ command: Schema.NonEmptyString })

const commandFrom = (metadata: PermissionEvaluation["metadata"]): string | undefined =>
  Schema.decodeUnknownOption(CommandMetadata)(metadata).pipe(
    Option.map(({ command }) => command.trim()),
    Option.filter((command) => command.length > 0),
    Option.getOrUndefined,
  )

export interface EvaluateOptions {
  readonly report?: (entry: {
    readonly effect: "allow" | "ask"
    readonly reason: "judged" | "unavailable" | "empty"
    readonly resources: number
  }) => void
}

export const createEvaluate = (
  reviewer: PermissionReviewer | undefined,
  options: EvaluateOptions,
): ((event: EvaluationEvent) => Effect.Effect<void>) =>
  Effect.fn("OpenCode.evaluatePermission")(function*(event) {
    if (event.effect !== "ask" || event.action !== "shell" || reviewer === undefined) return

    const command = commandFrom(event.metadata)

    if (event.resources.length > 1 && command === undefined) {
      options.report?.({ effect: "ask", reason: "unavailable", resources: event.resources.length })

      return
    }

    const resources = command === undefined
      ? event.resources
      : [...new Set([...event.resources, command])]

    const review = yield* reviewer.review({ action: event.action, resources })
    const reason = review.effect === "ask" ? review.reason : "judged"

    options.report?.({ effect: review.effect, reason, resources: resources.length })

    if (review.effect === "allow") event.effect = "allow"
  })

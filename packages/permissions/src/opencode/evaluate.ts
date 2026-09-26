import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Effect } from "effect"
import type { PermissionReviewer } from "../engine.ts"
import type { JevProviderFailure } from "../core.ts"

export interface EvaluationEvent {
  readonly sessionID: PermissionEvaluation["sessionID"]
  readonly agent?: PermissionEvaluation["agent"]
  readonly source?: PermissionEvaluation["source"]
  readonly action: string
  readonly resources: PermissionEvaluation["resources"]
  effect: PermissionEvaluation["effect"]
  message?: string
}

export interface EvaluateOptions {
  readonly inspect: (event: EvaluationEvent) => Effect.Effect<{
    readonly command: string
    readonly explicitAsk: boolean
  } | undefined>
  readonly report?: (entry: {
    readonly effect: "allow" | "ask"
    readonly reason: "judged" | "unavailable" | "empty"
    readonly resources: number
    readonly failure?: JevProviderFailure
  }) => void
}

export const createEvaluate = (
  reviewer: PermissionReviewer | undefined,
  options: EvaluateOptions,
): ((event: EvaluationEvent) => Effect.Effect<void>) =>
  Effect.fn("OpenCode.evaluatePermission")(function*(event) {
    if (event.effect !== "ask" || event.action !== "shell" || reviewer === undefined) return

    const inspection = yield* options.inspect(event)

    if (inspection === undefined) {
      options.report?.({ effect: "ask", reason: "unavailable", resources: event.resources.length })

      return
    }

    if (inspection.explicitAsk) return

    const review = yield* reviewer.review({ action: event.action, resources: [inspection.command] })
    const reason = review.effect === "ask" ? review.reason : "judged"

    if (review.effect === "ask" && review.failure !== undefined) {
      options.report?.({ effect: review.effect, reason, resources: 1, failure: review.failure })
    } else {
      options.report?.({ effect: review.effect, reason, resources: 1 })
    }

    if (review.effect === "allow") event.effect = "allow"
  })

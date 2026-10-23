import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import * as Clock from "effect/Clock"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type { PermissionReviewer } from "../engine.ts"
import type { JevProviderFailure } from "../core.ts"
import type { JevProvider } from "../core.ts"
import type { HistoryObserver } from "../history.ts"
import { withReviewEnabled } from "../review-control.ts"
import type { ReviewControl } from "../review-control.ts"

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
  readonly history?: { readonly observer: HistoryObserver; readonly provider: JevProvider }
  readonly control?: Pick<ReviewControl, "read">
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

    const reviewCommand = Effect.gen(function*() {
      const inspection = yield* options.inspect(event)

      if (inspection === undefined) {
        options.report?.({ effect: "ask", reason: "unavailable", resources: event.resources.length })

        return undefined
      }

      const started = yield* Clock.monotonicTimeNanos

      const review = inspection.explicitAsk
        ? "explicit-ask" as const
        : yield* reviewer.review({ action: event.action, resources: [inspection.command] })

      const completed = yield* Clock.monotonicTimeNanos

      if (options.history !== undefined) {
        const tsMs = yield* Clock.currentTimeMillis
        yield* Effect.suspend(() => options.history?.observer.observe({
          command: inspection.command,
          result: review,
          provider: options.history.provider,
          tsMs,
          latencyMs: review === "explicit-ask" ? null : Number(completed - started) / 1_000_000,
        }) ?? Effect.void).pipe(Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void))
      }

      return review === "explicit-ask" ? undefined : review
    })

    const review = yield* options.control === undefined
      ? reviewCommand
      : withReviewEnabled(options.control, "opencode", reviewCommand)

    if (review === undefined) return
    const reason = review.effect === "ask" ? review.reason : "judged"

    if (review.effect === "ask" && review.failure !== undefined) {
      options.report?.({ effect: review.effect, reason, resources: 1, failure: review.failure })
    } else {
      options.report?.({ effect: review.effect, reason, resources: 1 })
    }

    if (review.effect === "allow") event.effect = "allow"
  })

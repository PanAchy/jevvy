import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import { createReviewIndicator } from "./review-indicator.ts"
import type { ReviewIndicatorState } from "./review-indicator.ts"

export interface ReviewStatus {
  readonly enabled?: boolean
  readonly problem?: string
}

export class ReviewPresentationError extends Schema.TaggedError<ReviewPresentationError>()("ReviewPresentationError", {
  message: Schema.String,
}) {}

export interface ReviewPresentationHost {
  readonly read: Effect.Effect<ReviewStatus, ReviewPresentationError>
  readonly toggle: Effect.Effect<ReviewStatus, ReviewPresentationError>
  readonly render: (state: ReviewIndicatorState) => void
  readonly report: (message: string) => void
}

export class ReviewPresentation extends Context.Service<ReviewPresentation, {
  readonly refresh: Effect.Effect<void>
  readonly toggle: Effect.Effect<void>
}>()("@jevvy/permissions/ReviewPresentation") {
  static readonly layer = (host: ReviewPresentationHost) => Layer.effect(ReviewPresentation, Effect.gen(function*() {
    const mutex = yield* Semaphore.make(1)
    const refreshing = yield* Semaphore.make(1)
    const indicator = yield* createReviewIndicator(host.render)
    let disposed = false
    let reportedProblem: string | undefined

    const report = (problem: string | undefined) => {
      if (disposed || problem === reportedProblem) return
      reportedProblem = problem

      if (problem !== undefined) host.report(problem)
    }

    const operate = Effect.fn("ReviewPresentation.operate")(function*(operation: "read" | "toggle") {
      if (disposed) return

      const state = yield* (operation === "toggle" ? Effect.uninterruptible(host.toggle) : host.read).pipe(
        Effect.match({
          onSuccess: (status) => status,
          onFailure: (error): ReviewStatus => ({ problem: error.message }),
        }),
      )

      if (disposed) return
      yield* indicator.update(state.enabled)
      report(state.problem)
    }, mutex.withPermits(1))

    const refresh = Effect.fn("ReviewPresentation.refresh")(function*() {
      if (disposed) return
      yield* operate("read")
    }, refreshing.withPermitsIfAvailable(1), Effect.asVoid)

    yield* refresh().pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped)
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      disposed = true
    }))

    return ReviewPresentation.of({ refresh: refresh(), toggle: operate("toggle") })
  }))
}

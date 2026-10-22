import * as Clock from "effect/Clock"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { PermissionReview, PermissionReviewer } from "./engine.ts"
import { defaultApprovalQuestions } from "./questions.ts"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const Crossings = Schema.Struct({
  harmful: Count,
  sensitive: Count,
  untrusted: Count,
  obscured: Count,
} satisfies Record<keyof typeof defaultApprovalQuestions, typeof Count>)

export const MetricsSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scope: Schema.Literal("opencodePluginInstance"),
  policy: Schema.Literals(["shipped", "custom"]),
  timeoutMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  startedAtMs: Count,
  updatedAtMs: Count,
  expiresAtMs: Count,
  outcomes: Schema.Struct({ allow: Count, judgedAsk: Count, unavailable: Count, empty: Count }),
  durationMs: Schema.Struct({ below100: Count, from100To999: Count, atLeast1000: Count }),
  crossings: Schema.NullOr(Crossings),
  saturated: Schema.Boolean,
  incomplete: Schema.Boolean,
})

export interface MetricsSnapshot extends Schema.Schema.Type<typeof MetricsSnapshot> {}

export const METRICS_WRITER_LIMIT = 16

export const MetricsWriter = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  closed: Schema.Boolean,
  snapshot: MetricsSnapshot,
})

export interface MetricsWriter extends Schema.Schema.Type<typeof MetricsWriter> {}

export const MetricsDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  writers: Schema.Array(MetricsWriter).check(Schema.isMaxLength(METRICS_WRITER_LIMIT)),
})

export interface MetricsDocument extends Schema.Schema.Type<typeof MetricsDocument> {}

export const METRICS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000

export const decodeMetricsSnapshot = Effect.fn("ReviewMetrics.decode")(function*(raw: string) {
  if (raw.length > 4_096 || new TextEncoder().encode(raw).length > 4_096) return Option.none<MetricsSnapshot>()

  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(MetricsSnapshot), { onExcessProperty: "error" })(raw).pipe(Effect.option)

  if (Option.isNone(parsed)) return parsed

  const now = yield* Clock.currentTimeMillis
  const value = parsed.value
  const completed = Object.values(value.outcomes).reduce((sum, count) => sum + count, 0)
  const durations = Object.values(value.durationMs).reduce((sum, count) => sum + count, 0)

  if (value.expiresAtMs <= now || value.expiresAtMs !== value.startedAtMs + METRICS_LIFETIME_MS ||
    value.updatedAtMs < value.startedAtMs || value.updatedAtMs >= value.expiresAtMs || value.updatedAtMs > now ||
    !Number.isSafeInteger(completed) || completed !== durations ||
    (value.crossings !== null && Object.values(value.crossings).some((count) => count > value.outcomes.judgedAsk)) ||
    (value.policy === "custom") !== (value.crossings === null)) return Option.none<MetricsSnapshot>()

  return parsed
})

const increment = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, value + 1)

const emptySnapshot = (startedAtMs: number, policy: MetricsSnapshot["policy"], timeoutMs: number): MetricsSnapshot => ({
  schemaVersion: 1,
  scope: "opencodePluginInstance",
  policy,
  timeoutMs,
  startedAtMs,
  updatedAtMs: startedAtMs,
  expiresAtMs: startedAtMs + METRICS_LIFETIME_MS,
  outcomes: { allow: 0, judgedAsk: 0, unavailable: 0, empty: 0 },
  durationMs: { below100: 0, from100To999: 0, atLeast1000: 0 },
  crossings: policy === "shipped" ? { harmful: 0, sensitive: 0, untrusted: 0, obscured: 0 } : null,
  saturated: false,
  incomplete: false,
})

const crossed = (review: PermissionReview, key: keyof typeof defaultApprovalQuestions): boolean =>
  review.effect === "ask" && review.reason === "judged" && review.judgments.some((judgment) =>
    (judgment.answers[key]?.noul ?? 0) > defaultApprovalQuestions[key].threshold)

export const completeReviewSnapshot = (current: MetricsSnapshot, result: PermissionReview, elapsedMs: number): MetricsSnapshot => {
  if (current.saturated) return current

  const outcome = result.effect === "allow" ? "allow" : result.reason === "judged" ? "judgedAsk" : result.reason
  const duration = elapsedMs < 100 ? "below100" : elapsedMs < 1_000 ? "from100To999" : "atLeast1000"

  const crossings = current.crossings === null ? null : {
    harmful: crossed(result, "harmful") ? increment(current.crossings.harmful) : current.crossings.harmful,
    sensitive: crossed(result, "sensitive") ? increment(current.crossings.sensitive) : current.crossings.sensitive,
    untrusted: crossed(result, "untrusted") ? increment(current.crossings.untrusted) : current.crossings.untrusted,
    obscured: crossed(result, "obscured") ? increment(current.crossings.obscured) : current.crossings.obscured,
  }

  const outcomes = { ...current.outcomes, [outcome]: increment(current.outcomes[outcome]) }
  const durationMs = { ...current.durationMs, [duration]: increment(current.durationMs[duration]) }

  return {
    schemaVersion: current.schemaVersion,
    scope: current.scope,
    policy: current.policy,
    timeoutMs: current.timeoutMs,
    startedAtMs: current.startedAtMs,
    updatedAtMs: current.updatedAtMs,
    expiresAtMs: current.expiresAtMs,
    outcomes,
    durationMs,
    crossings,
    saturated: Object.values(outcomes).reduce((sum, count) => sum + count, 0) >= Number.MAX_SAFE_INTEGER,
    incomplete: current.incomplete,
  }
}

export const createReviewMetrics = Effect.fn("ReviewMetrics.create")(function*(
  reviewer: PermissionReviewer,
  policy: MetricsSnapshot["policy"],
  timeoutMs: number,
) {
  const startedAtMs = yield* Clock.currentTimeMillis

  const state = yield* Ref.make(emptySnapshot(startedAtMs, policy, timeoutMs))

  const observed: PermissionReviewer = {
    review: Effect.fn("ReviewMetrics.review")(function*(request) {
      const start = yield* Clock.currentTimeNanos
      const result = yield* reviewer.review(request)

      yield* Effect.gen(function*() {
        const end = yield* Clock.currentTimeNanos
        const now = yield* Clock.currentTimeMillis

        yield* Ref.update(state, (previous) => completeReviewSnapshot(
          now >= previous.expiresAtMs ? emptySnapshot(now, policy, timeoutMs) : previous,
          result,
          Number(end - start) / 1_000_000,
        ))
      }).pipe(Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => Ref.update(state, (current) => ({
        schemaVersion: current.schemaVersion,
        scope: current.scope,
        policy: current.policy,
        timeoutMs: current.timeoutMs,
        startedAtMs: current.startedAtMs,
        updatedAtMs: current.updatedAtMs,
        expiresAtMs: current.expiresAtMs,
        outcomes: current.outcomes,
        durationMs: current.durationMs,
        crossings: current.crossings,
        saturated: current.saturated,
        incomplete: true,
      }))))

      return result
    }),
  }

  const snapshot = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const current = yield* Ref.updateAndGet(state, (previous) => now >= previous.expiresAtMs ? emptySnapshot(now, policy, timeoutMs) : previous)

    return {
      schemaVersion: current.schemaVersion,
      scope: current.scope,
      policy: current.policy,
      timeoutMs: current.timeoutMs,
      startedAtMs: current.startedAtMs,
      updatedAtMs: now,
      expiresAtMs: current.expiresAtMs,
      outcomes: current.outcomes,
      durationMs: current.durationMs,
      crossings: current.crossings,
      saturated: current.saturated,
      incomplete: current.incomplete,
    }
  })

  return { reviewer: observed, snapshot }
})

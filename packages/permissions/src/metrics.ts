import * as Clock from "effect/Clock"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { PermissionReview, PermissionReviewer } from "./engine.ts"
import { defaultApprovalQuestions } from "./questions.ts"

export const METRICS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const Crossings = Schema.Struct({
  harmful: Count,
  sensitive: Count,
  untrusted: Count,
  obscured: Count,
} satisfies Record<keyof typeof defaultApprovalQuestions, typeof Count>)

export const MetricsSnapshot = Schema.Struct({
  startedAtMs: Count.annotate({ description: "Unix milliseconds at aggregate-window start." }),
  updatedAtMs: Count.annotate({ description: "Unix milliseconds at snapshot time; must be within [startedAtMs, expiresAtMs) and not in the future." }),
  expiresAtMs: Count.annotate({ description: `Unix milliseconds at expiry; equals startedAtMs + ${METRICS_LIFETIME_MS}. Exclude expired entries.` }),
  outcomes: Schema.Struct({
    allow: Count.annotate({ description: "Jevvy supplied approval; does not prove command execution or prompts saved." }),
    judgedAsk: Count.annotate({ description: "A valid judgment required abstention under the active policy." }),
    unavailable: Count.annotate({ description: "The reviewer could not obtain a usable judgment, including timeout or provider failure." }),
  }).annotate({
    description: "Completed nonempty review invocations, including cache hits, not provider calls. Abstentions = judgedAsk + unavailable; these are not host prompts or denials.",
  }),
  crossings: Schema.NullOr(Crossings).annotate({
    description: "Strict shipped-question threshold crossings per judgedAsk review. Counts overlap; use judgedAsk as denominator. Null when using custom questions, not zero crossings. Not calibration evidence or a threshold-tuning recommendation.",
  }),
  saturated: Schema.Boolean.annotate({ description: "Counters stopped at the safe-integer limit." }),
  incomplete: Schema.Boolean.annotate({ description: "An observer update failed. False does not guarantee complete capture: persistence can lose updates independently." }),
}).annotate({ description: "Completed = sum(outcomes), a safe integer. Each crossing count must not exceed judgedAsk. Empty requests, interruptions and defects have no completed count." })

export interface MetricsSnapshot extends Schema.Schema.Type<typeof MetricsSnapshot> {}

export const METRICS_WRITER_LIMIT = 16

export const MetricsWriter = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)).annotate({ description: "Random writer-ownership token, not a user, session or task identity." }),
  closed: Schema.Boolean.annotate({ description: "The writer completed a best-effort shutdown flush; retained closed entries may be evicted early." }),
  snapshot: MetricsSnapshot,
})

export interface MetricsWriter extends Schema.Schema.Type<typeof MetricsWriter> {}

export const MetricsDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  writers: Schema.Array(MetricsWriter).check(Schema.isMaxLength(METRICS_WRITER_LIMIT)),
}).annotate({ description: "Recent, best-effort OpenCode review outcomes and shipped-question abstention reasons, not command history or complete weekly totals. Entries can be evicted before expiry. Model/provider and policy identity are absent; do not compare configurations or infer safety accuracy. Sparse counts can disclose an individual outcome." })

export interface MetricsDocument extends Schema.Schema.Type<typeof MetricsDocument> {}

export const decodeMetricsSnapshot = Effect.fn("ReviewMetrics.decode")(function*(raw: string) {
  if (raw.length > 4_096 || new TextEncoder().encode(raw).length > 4_096) return Option.none<MetricsSnapshot>()

  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(MetricsSnapshot), { onExcessProperty: "error" })(raw).pipe(Effect.option)

  if (Option.isNone(parsed)) return parsed

  const now = yield* Clock.currentTimeMillis
  const value = parsed.value
  const completed = Object.values(value.outcomes).reduce((sum, count) => sum + count, 0)

  if (value.expiresAtMs <= now || value.expiresAtMs !== value.startedAtMs + METRICS_LIFETIME_MS ||
    value.updatedAtMs < value.startedAtMs || value.updatedAtMs >= value.expiresAtMs || value.updatedAtMs > now ||
    !Number.isSafeInteger(completed) ||
    (value.crossings !== null && Object.values(value.crossings).some((count) => count > value.outcomes.judgedAsk))) return Option.none<MetricsSnapshot>()

  return parsed
})

const increment = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, value + 1)

const emptySnapshot = (startedAtMs: number, shippedQuestions: boolean): MetricsSnapshot => ({
  startedAtMs,
  updatedAtMs: startedAtMs,
  expiresAtMs: startedAtMs + METRICS_LIFETIME_MS,
  outcomes: { allow: 0, judgedAsk: 0, unavailable: 0 },
  crossings: shippedQuestions ? { harmful: 0, sensitive: 0, untrusted: 0, obscured: 0 } : null,
  saturated: false,
  incomplete: false,
})

const crossed = (review: PermissionReview, key: keyof typeof defaultApprovalQuestions): boolean =>
  review.effect === "ask" && review.reason === "judged" && review.judgments.some((judgment) =>
    (judgment.answers[key]?.noul ?? 0) > defaultApprovalQuestions[key].threshold)

export const completeReviewSnapshot = (current: MetricsSnapshot, result: PermissionReview): MetricsSnapshot => {
  if (current.saturated) return current

  const outcome = result.effect === "allow" ? "allow" : result.reason === "judged" ? "judgedAsk" : result.reason

  if (outcome === "empty") return current

  const crossings = current.crossings === null ? null : {
    harmful: crossed(result, "harmful") ? increment(current.crossings.harmful) : current.crossings.harmful,
    sensitive: crossed(result, "sensitive") ? increment(current.crossings.sensitive) : current.crossings.sensitive,
    untrusted: crossed(result, "untrusted") ? increment(current.crossings.untrusted) : current.crossings.untrusted,
    obscured: crossed(result, "obscured") ? increment(current.crossings.obscured) : current.crossings.obscured,
  }

  const outcomes = { ...current.outcomes, [outcome]: increment(current.outcomes[outcome]) }

  return {
    ...current,
    outcomes,
    crossings,
    saturated: Object.values(outcomes).reduce((sum, count) => sum + count, 0) >= Number.MAX_SAFE_INTEGER,
  }
}

export const createReviewMetrics = Effect.fn("ReviewMetrics.create")(function*(
  reviewer: PermissionReviewer,
  shippedQuestions: boolean,
) {
  const startedAtMs = yield* Clock.currentTimeMillis

  const state = yield* Ref.make(emptySnapshot(startedAtMs, shippedQuestions))

  const observed: PermissionReviewer = {
    review: Effect.fn("ReviewMetrics.review")(function*(request) {
      const result = yield* reviewer.review(request)

      yield* Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis

        yield* Ref.update(state, (previous) => completeReviewSnapshot(
          now >= previous.expiresAtMs ? emptySnapshot(now, shippedQuestions) : previous,
          result,
        ))
      }).pipe(Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => Ref.update(state, (current) => ({
        ...current,
        incomplete: true,
      }))))

      return result
    }),
  }

  const snapshot = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const current = yield* Ref.updateAndGet(state, (previous) => now >= previous.expiresAtMs ? emptySnapshot(now, shippedQuestions) : previous)

    return {
      ...current,
      updatedAtMs: now,
    }
  })

  return { reviewer: observed, snapshot }
})

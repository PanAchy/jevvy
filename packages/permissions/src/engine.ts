import { Cache, Clock, Duration, Effect, Exit, Ref, Schema } from "effect"
import { isJevProviderError, JevProviderFailure as JevProviderFailureSchema, providerFailureOf } from "./core.ts"
import type { JevClient, JevProviderFailure, JevResult, NoulAnswer } from "./core.ts"
import type { ApprovalQuestion, ApprovalQuestions } from "./questions.ts"
import { defaultApprovalQuestions, toNoulQuestions } from "./questions.ts"

export type PermissionEffect = "allow" | "ask"

export interface ResourceJudgment {
  readonly resource: string
  readonly effect: PermissionEffect
  readonly model: string
  readonly answers: Readonly<Record<string, NoulAnswer>>
}

export type PermissionReview =
  | {
      readonly effect: "allow"
      readonly judgments: readonly ResourceJudgment[]
    }
  | {
      readonly effect: "ask"
      readonly reason: "judged" | "unavailable" | "empty"
      readonly judgments: readonly ResourceJudgment[]
      readonly failure?: JevProviderFailure
    }

export interface PermissionRequest {
  readonly action: string
  readonly resources: readonly string[]
}

export interface PermissionReviewer {
  readonly review: (request: PermissionRequest) => Effect.Effect<PermissionReview>
}

export interface PermissionReviewerOptions {
  readonly questions?: ApprovalQuestions
  readonly timeoutMs?: number
  readonly cacheCapacity?: number
}

interface ProviderCooldown {
  readonly failure: JevProviderFailure
  readonly untilMs: number
}

const RATE_LIMIT_COOLDOWN_MS = 60_000

const EXHAUSTED_COOLDOWN_MS = 5 * 60_000

const cooldownMs = (failure: JevProviderFailure): number | undefined => {
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs

  if (failure.kind === "rate-limited") return RATE_LIMIT_COOLDOWN_MS

  if (failure.kind === "credits-exhausted" || failure.kind === "quota-exhausted") {
    return EXHAUSTED_COOLDOWN_MS
  }

  return undefined
}

class JudgmentUnavailable extends Schema.TaggedError<JudgmentUnavailable>()("JudgmentUnavailable", {
  message: Schema.String,
  failure: Schema.optional(JevProviderFailureSchema),
}) {}

export class ReviewerConfigurationError extends Schema.TaggedError<ReviewerConfigurationError>()(
  "ReviewerConfigurationError",
  { message: Schema.String },
) {}

const answerPasses = (answer: number, question: ApprovalQuestion): boolean =>
  question.threshold.direction === "atMost"
    ? answer <= question.threshold.value
    : answer >= question.threshold.value

const validAnswer = (answer: NoulAnswer | undefined): answer is NoulAnswer =>
  answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1

export const permissionEffectOf = (
  answers: Readonly<Record<string, NoulAnswer>>,
  questions: ApprovalQuestions,
): PermissionEffect => {
  let effect: PermissionEffect = "allow"

  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key]

    if (!validAnswer(answer)) throw new JudgmentUnavailable({ message: `missing valid answer for ${key}` })

    if (!answerPasses(answer.noul, question)) effect = "ask"
  }

  return effect
}

const judgeResult = (
  resource: string,
  result: JevResult,
  questions: ApprovalQuestions,
): ResourceJudgment => {
  if (result.model.trim().length === 0) throw new JudgmentUnavailable({ message: "missing model identifier" })

  return {
    resource,
    effect: permissionEffectOf(result.answers, questions),
    model: result.model,
    answers: result.answers,
  }
}

const validateQuestions = (questions: ApprovalQuestions): Effect.Effect<void, ReviewerConfigurationError> => Effect.try({
  try: () => {
  const entries = Object.entries(questions)

  if (entries.length === 0) throw new Error("at least one approval question is required")

  for (const [key, question] of entries) {
    if (key.length === 0) throw new Error("approval question keys cannot be empty")

    if (question.instructions.trim().length === 0) throw new Error(`approval question ${key} has no instructions`)

    if (!Number.isFinite(question.threshold.value) || question.threshold.value < 0 || question.threshold.value > 1) {
      throw new Error(`approval question ${key} has an invalid threshold`)
    }
  }
  },
  catch: (cause) => new ReviewerConfigurationError({
    message: cause instanceof Error ? cause.message : "invalid approval questions",
  }),
})

const cacheKey = (action: string, resource: string): string => `${action.length}:${action}${resource}`

const unavailable = (error: Error): JudgmentUnavailable => {
  if (error instanceof JudgmentUnavailable) return error

  if (isJevProviderError(error)) {
    return new JudgmentUnavailable({ message: error.message, failure: providerFailureOf(error) })
  }

  return new JudgmentUnavailable({ message: String(error) })
}

export const createPermissionReviewer = Effect.fn("PermissionReviewer.create")(function*(
  client: JevClient,
  options: PermissionReviewerOptions = {},
): Effect.fn.Return<PermissionReviewer, ReviewerConfigurationError> {
  const questions = options.questions ?? defaultApprovalQuestions
  const timeoutMs = options.timeoutMs ?? 5_000
  const capacity = options.cacheCapacity ?? 512

  yield* validateQuestions(questions)

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return yield* new ReviewerConfigurationError({ message: "timeoutMs must be positive" })
  }

  if (!Number.isInteger(capacity) || capacity <= 0) {
    return yield* new ReviewerConfigurationError({ message: "cacheCapacity must be a positive integer" })
  }

  const noulQuestions = toNoulQuestions(questions)
  const providerCooldown = yield* Ref.make<ProviderCooldown | undefined>(undefined)

  const activeProviderFailure = Effect.fn("PermissionReviewer.activeProviderFailure")(function*() {
    const now = yield* Clock.currentTimeMillis

    return yield* Ref.modify(
      providerCooldown,
      (current): readonly [JevProviderFailure | undefined, ProviderCooldown | undefined] => {
        if (current === undefined || current.untilMs <= now) return [undefined, undefined]

        return [current.failure, current]
      },
    )
  })

  const recordProviderCooldown = Effect.fn("PermissionReviewer.recordProviderCooldown")(function*(
    failure: JevProviderFailure,
  ) {
    const duration = cooldownMs(failure)

    if (duration === undefined) return

    const now = yield* Clock.currentTimeMillis
    const next = { failure, untilMs: now + duration }

    yield* Ref.update(providerCooldown, (current) =>
      current === undefined || current.untilMs < next.untilMs ? next : current)
  })

  const judgeResource = Effect.fn("PermissionReviewer.judgeResource")(function*(key: string) {
    const separator = key.indexOf(":")
    const actionLength = Number(key.slice(0, separator))
    const payload = key.slice(separator + 1)
    const action = payload.slice(0, actionLength)
    const resource = payload.slice(actionLength)
    const disabled = yield* activeProviderFailure()

    if (disabled !== undefined) {
      return yield* new JudgmentUnavailable({ message: disabled.message, failure: disabled })
    }

    return yield* client.evaluate({ state: { action, resource }, questions: noulQuestions }).pipe(
      Effect.timeout(timeoutMs),
      Effect.flatMap((result) => Effect.try({
        try: () => judgeResult(resource, result, questions),
        catch: (cause) => unavailable(cause instanceof Error ? cause : new Error(String(cause))),
      })),
      Effect.mapError(unavailable),
      Effect.tapError((error) => error.failure === undefined
        ? Effect.succeed(undefined)
        : recordProviderCooldown(error.failure)),
    )
  })

  const cache = yield* Cache.makeWith(judgeResource, {
    capacity,
    timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  })

  return {
    review: Effect.fn("PermissionReviewer.review")(function*(request) {
      if (request.resources.length === 0) return { effect: "ask", reason: "empty", judgments: [] }

      const disabled = yield* activeProviderFailure()

      if (disabled !== undefined) {
        return { effect: "ask", reason: "unavailable", judgments: [], failure: disabled }
      }

      const judgments: ResourceJudgment[] = []

      for (const resource of request.resources) {
        const result = yield* Cache.get(cache, cacheKey(request.action, resource)).pipe(
          Effect.match({
            onFailure: (error) => ({ kind: "failure" as const, error }),
            onSuccess: (judgment) => ({ kind: "success" as const, judgment }),
          }),
        )

        if (result.kind === "failure") {
          if (result.error.failure !== undefined) {
            return {
              effect: "ask",
              reason: "unavailable",
              judgments,
              failure: result.error.failure,
            }
          }

          return {
            effect: "ask",
            reason: "unavailable",
            judgments,
          }
        }

        judgments.push(result.judgment)

        if (result.judgment.effect === "ask") return { effect: "ask", reason: "judged", judgments }
      }

      return { effect: "allow", judgments }
    }),
  }
})

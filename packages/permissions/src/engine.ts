import { Cache, Duration, Effect, Exit } from "effect"
import type { JevClient, JevResult, NoulAnswer } from "./core.ts"
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
    }

export interface PermissionRequest {
  readonly action: string
  readonly resources: readonly string[]
}

export interface PermissionReviewer {
  readonly review: (request: PermissionRequest, signal?: AbortSignal) => Promise<PermissionReview>
  readonly dispose: () => Promise<void>
}

export interface PermissionReviewerOptions {
  readonly questions?: ApprovalQuestions
  readonly timeoutMs?: number
  readonly cacheCapacity?: number
}

class JudgmentUnavailable extends Error {
  readonly name = "JudgmentUnavailable"
}

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

    if (!validAnswer(answer)) throw new JudgmentUnavailable(`missing valid answer for ${key}`)

    if (!answerPasses(answer.noul, question)) effect = "ask"
  }

  return effect
}

const judgeResult = (
  resource: string,
  result: JevResult,
  questions: ApprovalQuestions,
): ResourceJudgment => {
  if (result.model.trim().length === 0) throw new JudgmentUnavailable("missing model identifier")

  return {
    resource,
    effect: permissionEffectOf(result.answers, questions),
    model: result.model,
    answers: result.answers,
  }
}

const validateQuestions = (questions: ApprovalQuestions): void => {
  const entries = Object.entries(questions)

  if (entries.length === 0) throw new Error("at least one approval question is required")

  for (const [key, question] of entries) {
    if (key.length === 0) throw new Error("approval question keys cannot be empty")

    if (question.instructions.trim().length === 0) throw new Error(`approval question ${key} has no instructions`)

    if (!Number.isFinite(question.threshold.value) || question.threshold.value < 0 || question.threshold.value > 1) {
      throw new Error(`approval question ${key} has an invalid threshold`)
    }
  }
}

const cacheKey = (action: string, resource: string): string => `${action.length}:${action}${resource}`

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")

const isAborted = (signal: AbortSignal | undefined): signal is AbortSignal => signal?.aborted === true

export const createPermissionReviewer = async (
  client: JevClient,
  options: PermissionReviewerOptions = {},
): Promise<PermissionReviewer> => {
  const questions = options.questions ?? defaultApprovalQuestions
  const timeoutMs = options.timeoutMs ?? 5_000
  const capacity = options.cacheCapacity ?? 512

  validateQuestions(questions)

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive")

  if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("cacheCapacity must be a positive integer")

  const noulQuestions = toNoulQuestions(questions)

  const cache = await Effect.runPromise(
    Cache.makeWith(
      (key: string) => {
        const separator = key.indexOf(":")
        const actionLength = Number(key.slice(0, separator))
        const payload = key.slice(separator + 1)
        const action = payload.slice(0, actionLength)
        const resource = payload.slice(actionLength)

        return Effect.tryPromise((signal) =>
          client.evaluate({ state: { action, resource }, questions: noulQuestions }, signal)
        ).pipe(
          Effect.timeout(timeoutMs),
          Effect.map((result) => judgeResult(resource, result, questions)),
          Effect.mapError((error) => new JudgmentUnavailable(String(error))),
        )
      },
      {
        capacity,
        timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
      },
    ),
  )

  return {
    async review(request, signal) {
      if (request.resources.length === 0) return { effect: "ask", reason: "empty", judgments: [] }

      const judgments: ResourceJudgment[] = []

      for (const resource of request.resources) {
        if (isAborted(signal)) throw abortReason(signal)

        try {
          const judgment = await Effect.runPromise(
            Cache.get(cache, cacheKey(request.action, resource)),
            signal === undefined ? undefined : { signal },
          )

          judgments.push(judgment)

          if (judgment.effect === "ask") return { effect: "ask", reason: "judged", judgments }
        } catch {
          if (isAborted(signal)) throw abortReason(signal)

          return { effect: "ask", reason: "unavailable", judgments }
        }
      }

      return { effect: "allow", judgments }
    },
    async dispose() {
      await client.dispose?.()
    },
  }
}

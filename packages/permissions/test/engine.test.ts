import { describe, expect, it, vi } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { JevProviderError } from "@jevvy/core"
import type { JevClient, JevProviderError as JevProviderErrorType, JevRequest, JevResult } from "@jevvy/core"
import { createPermissionReviewer } from "../src/engine.ts"
import type { ApprovalQuestions } from "../src/questions.ts"

const answer = (value: number): JevResult => ({
  model: "jev-test",
  answers: {
    harmful: { type: "noul", noul: value },
    sensitive: { type: "noul", noul: value },
    untrusted: { type: "noul", noul: value },
    obscured: { type: "noul", noul: value },
  },
})

const fakeClient = (
  evaluate: (request: JevRequest) => Effect.Effect<JevResult, JevProviderErrorType>,
): JevClient => ({ evaluate })

describe("permission reviewer", () => {
  it.effect("allows only when every resource independently passes every question", () => Effect.gen(function*() {
    const requests: JevRequest[] = []

    const reviewer = yield* createPermissionReviewer(fakeClient((request) => Effect.sync(() => {
      requests.push(request)

      return answer(0.01)
    })))

    const result = yield* reviewer.review({ action: "shell", resources: ["git status", "pwd"] })

    expect(result.effect).toBe("allow")
    expect(requests.map((request) => request.state)).toEqual([
      { action: "shell", resource: "git status" },
      { action: "shell", resource: "pwd" },
    ])
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["harmful", "sensitive", "untrusted", "obscured"])
  }))

  it.effect("asks when one valid answer crosses its threshold", () => Effect.gen(function*() {
    const reviewer = yield* createPermissionReviewer(fakeClient(() => Effect.succeed(answer(0.9))))

    const result = yield* reviewer.review({ action: "shell", resources: ["git push --force"] })

    expect(result).toMatchObject({
      effect: "ask",
      reason: "judged",
    })
  }))

  it.effect("caches valid allow and ask judgments for the reviewer lifetime", () => Effect.gen(function*() {
    const evaluate = vi.fn((request: JevRequest) => Effect.succeed(
      JSON.stringify(request.state).includes("never") ? answer(0.9) : answer(0.01),
    )
    )

    const reviewer = yield* createPermissionReviewer(fakeClient(evaluate))

    yield* reviewer.review({ action: "shell", resources: ["pwd"] })
    yield* reviewer.review({ action: "shell", resources: ["pwd"] })
    yield* reviewer.review({ action: "shell", resources: ["never"] })
    yield* reviewer.review({ action: "shell", resources: ["never"] })

    expect(evaluate).toHaveBeenCalledTimes(2)
  }))

  it.effect("does not cache provider failures or malformed results", () => Effect.gen(function*() {
    let attempts = 0

    const reviewer = yield* createPermissionReviewer(fakeClient(() => Effect.suspend(() => {
      attempts += 1

      if (attempts === 1) {
        return new JevProviderError({ provider: "zen", kind: "unavailable", message: "offline" })
      }

      if (attempts === 2) return Effect.succeed({ model: "jev-test", answers: {} })

      return Effect.succeed(answer(0.01))
    })))

    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({ reason: "unavailable" })
    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({ reason: "unavailable" })
    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({ effect: "allow" })
    expect(attempts).toBe(3)
  }))

  it.effect("preserves modeled provider failure evidence while abstaining", () => Effect.gen(function*() {
    const reviewer = yield* createPermissionReviewer(fakeClient(() => new JevProviderError({
      message: "Insufficient balance",
      provider: "zen",
      kind: "credits-exhausted",
      status: 401,
      code: "CreditsError",
    })))

    const result = yield* reviewer.review({ action: "shell", resources: ["pwd"] })

    expect(result).toMatchObject({
      effect: "ask",
      reason: "unavailable",
      failure: {
        provider: "zen",
        kind: "credits-exhausted",
        status: 401,
        code: "CreditsError",
      },
    })
  }))

  it.effect.each(["credits-exhausted", "quota-exhausted"] as const)(
    "pauses provider review after %s and resumes after cooldown",
    (kind) => Effect.gen(function*() {
      let attempts = 0

      const evaluate = vi.fn(() => Effect.suspend(() => {
        attempts += 1

        return attempts === 2
          ? new JevProviderError({
            message: "Insufficient balance",
            provider: "zen",
            kind,
            status: 401,
            code: "CreditsError",
          })
          : Effect.succeed(answer(0.01))
      }))

      const reviewer = yield* createPermissionReviewer(fakeClient(evaluate))

      const cached = yield* reviewer.review({ action: "shell", resources: ["pwd"] })
      const exhausted = yield* reviewer.review({ action: "shell", resources: ["git status"] })
      const duringCooldown = yield* reviewer.review({ action: "shell", resources: ["pwd"] })

      yield* TestClock.adjust("5 minutes")

      const afterCooldown = yield* reviewer.review({ action: "shell", resources: ["git diff"] })

      expect(cached).toMatchObject({ effect: "allow" })
      expect(exhausted).toMatchObject({
        effect: "ask",
        reason: "unavailable",
        failure: { kind },
      })
      expect(duringCooldown).toMatchObject({
        effect: "ask",
        reason: "unavailable",
        failure: { kind },
      })
      expect(afterCooldown).toMatchObject({ effect: "allow" })
      expect(evaluate).toHaveBeenCalledTimes(3)
    }),
  )

  it.effect("honors rate-limit retry timing", () => Effect.gen(function*() {
    const evaluate = vi.fn()
      .mockReturnValueOnce(new JevProviderError({
        message: "Slow down",
        provider: "zen",
        kind: "rate-limited",
        status: 429,
        retryAfterMs: 1_000,
      }))
      .mockReturnValueOnce(Effect.succeed(answer(0.01)))

    const reviewer = yield* createPermissionReviewer(fakeClient(evaluate))

    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({
      effect: "ask",
      reason: "unavailable",
      failure: { kind: "rate-limited" },
    })
    expect(yield* reviewer.review({ action: "shell", resources: ["git status"] })).toMatchObject({
      effect: "ask",
      reason: "unavailable",
      failure: { kind: "rate-limited" },
    })
    expect(evaluate).toHaveBeenCalledOnce()

    yield* TestClock.adjust("1 second")

    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({ effect: "allow" })
    expect(evaluate).toHaveBeenCalledTimes(2)
  }))

  it.effect("uses a bounded fallback cooldown when a rate limit has no retry timing", () => Effect.gen(function*() {
    const evaluate = vi.fn()
      .mockReturnValueOnce(new JevProviderError({
        message: "Slow down",
        provider: "zen",
        kind: "rate-limited",
        status: 429,
      }))
      .mockReturnValueOnce(Effect.succeed(answer(0.01)))

    const reviewer = yield* createPermissionReviewer(fakeClient(evaluate))

    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({
      effect: "ask",
      reason: "unavailable",
      failure: { kind: "rate-limited" },
    })
    expect(yield* reviewer.review({ action: "shell", resources: ["git status"] })).toMatchObject({
      effect: "ask",
      reason: "unavailable",
      failure: { kind: "rate-limited" },
    })
    expect(evaluate).toHaveBeenCalledOnce()

    yield* TestClock.adjust("1 minute")

    expect(yield* reviewer.review({ action: "shell", resources: ["pwd"] })).toMatchObject({ effect: "allow" })
    expect(evaluate).toHaveBeenCalledTimes(2)
  }))

  it.effect("abstains without a provider call when no resource exists", () => Effect.gen(function*() {
    const evaluate = vi.fn(() => Effect.succeed(answer(0.01)))
    const reviewer = yield* createPermissionReviewer(fakeClient(evaluate))

    const result = yield* reviewer.review({ action: "shell", resources: [] })

    expect(result).toEqual({
      effect: "ask",
      reason: "empty",
      judgments: [],
    })
    expect(evaluate).not.toHaveBeenCalled()
  }))

  it.effect("supports a custom System One question and Jevvy threshold", () => Effect.gen(function*() {
    const questions: ApprovalQuestions = {
      harmful: {
        type: "noul",
        instructions: "Could this cause harm in this domain?",
        threshold: 0.2,
      },
    }

    const reviewer = yield* createPermissionReviewer(fakeClient(() => Effect.succeed({
      model: "jev-test",
      answers: { harmful: { type: "noul", noul: 0.1 } },
    })), { questions })

    expect(yield* reviewer.review({ action: "shell", resources: ["domain command"] })).toMatchObject({ effect: "allow" })
  }))

  it.effect("rejects an empty custom question set", () => Effect.gen(function*() {
    const questions: ApprovalQuestions = {}

    const error = yield* Effect.flip(createPermissionReviewer(
      fakeClient(() => Effect.succeed(answer(0.01))),
      { questions },
    ))

    expect(error).toMatchObject({
      name: "ReviewerConfigurationError",
      message: "invalid approval questions",
    })
  }))

  it.effect("propagates interruption instead of converting it to abstention", () => Effect.gen(function*() {
    const reviewer = yield* createPermissionReviewer(fakeClient(() => Effect.never))
    const fiber = yield* Effect.forkChild(reviewer.review({ action: "shell", resources: ["pwd"] }))
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }))
})

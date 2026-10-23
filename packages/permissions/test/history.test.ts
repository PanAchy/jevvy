import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import * as Fiber from "effect/Fiber"
import * as Deferred from "effect/Deferred"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { Session } from "@opencode/schema/session"
import { HISTORY_EVENT_BYTES, HistoryEvent, HistoryRequest, HistoryResponse, eventBytes, projectHistory } from "../src/history.ts"
import type { HistoryObservation } from "../src/history.ts"
import { createPermissionReviewer } from "../src/engine.ts"
import type { PermissionReview } from "../src/engine.ts"
import { createEvaluate } from "../src/opencode/evaluate.ts"
import type { EvaluationEvent } from "../src/opencode/evaluate.ts"

const id = "00000000-0000-4000-8000-000000000001"

const command = "printf 'synthetic-secret-🔐'; cd /fixture && echo '$(untrusted)' > out"

const judgment = { resource: command, effect: "allow" as const, model: "actual-reported-model", answers: { "dynamic-untrusted-name": { type: "noul" as const, noul: 0.125 } } }

const input = (result: PermissionReview | "explicit-ask" = { effect: "allow", judgments: [judgment] }): HistoryObservation => ({ command, result, provider: "custom", tsMs: 1_000, latencyMs: 7 })

const hostEvent = (effect: EvaluationEvent["effect"] = "ask", action = "shell"): EvaluationEvent => ({ sessionID: Session.ID.make("ses_history"), action, resources: ["partial-pattern"], effect })

describe("review history projection", () => {
  it("keeps exact commands, dynamic raw answers and actual model without policy or error envelopes", () => {
    const event = projectHistory(input(), id)
    expect(event).toMatchObject({ id, command, effect: "allow", reason: "judged", model: judgment.model, latencyMs: 7, detail: { answers: judgment.answers } })
    expect(event === undefined ? 0 : eventBytes(event)).toBeLessThan(HISTORY_EVENT_BYTES)
  })

  it.each(["allow", "ask"] as const)("projects judged %s", (effect) => {
    const event = projectHistory(input(effect === "allow" ? { effect, judgments: [judgment] } : { effect, reason: "judged", judgments: [judgment] }), id)
    expect(event).toMatchObject({ effect, reason: "judged", model: judgment.model })
  })

  it.each(["unavailable", "empty", "explicit-ask"] as const)("uses truthful null fields for %s", (reason) => {
    const event = projectHistory(input(reason === "explicit-ask" ? reason : { effect: "ask", reason, judgments: [] }), id)
    expect(event).toMatchObject({ effect: "ask", reason, model: null, detail: { answers: null, failure: null } })
    expect(event?.latencyMs).toBe(reason === "explicit-ask" ? null : 7)
  })

  it("rebuilds only safe failure fields and normalizes invalid optional numbers", () => {
    const event = projectHistory(input({ effect: "ask", reason: "unavailable", judgments: [], failure: {
      provider: "microsoft", kind: "rate-limited", status: 429, retryAfterMs: Infinity, message: "secret-error-message", code: "secret-error-code",
    } }), id)

    expect(event?.detail.failure).toEqual({ provider: "microsoft", kind: "rate-limited", status: 429, retryAfterMs: null })
    expect(JSON.stringify(event)).not.toContain("secret-error")
  })

  it.each(["x".repeat(HISTORY_EVENT_BYTES + 1), "🔐".repeat(HISTORY_EVENT_BYTES / 3)])("drops oversized commands whole", (large) => {
    expect(projectHistory({ ...input("explicit-ask"), command: large }, id)).toBeUndefined()
  })

  it("drops oversized answers without truncation", () => {
    const answers = Object.fromEntries(Array.from({ length: 1100 }, (_, index) => [`dynamic-${index}`, { type: "noul" as const, noul: 0.5 }]))
    expect(projectHistory(input({ effect: "allow", judgments: [{ ...judgment, answers }] }), id)).toBeUndefined()
  })

  it.each([NaN, Infinity, -1])("rejects invalid review duration %s", (latencyMs) => {
    expect(projectHistory({ ...input(), latencyMs }, id)).toBeUndefined()
  })

  it("rejects partial command judgments, multiple judgments and invalid raw answers", () => {
    expect(projectHistory(input({ effect: "allow", judgments: [{ ...judgment, resource: "partial" }] }), id)).toBeUndefined()
    expect(projectHistory(input({ effect: "allow", judgments: [judgment, judgment] }), id)).toBeUndefined()
    expect(projectHistory(input({ effect: "allow", judgments: [{ ...judgment, answers: { bad: { type: "noul", noul: NaN } } }] }), id)).toBeUndefined()
  })

  it("strictly decodes event and worker protocol boundaries", () => {
    const event = projectHistory(input(), id)
    const decode = Schema.decodeUnknownOption(HistoryEvent, { onExcessProperty: "error" })
    expect(decode({ ...event, effect: "allow", reason: "explicit-ask" })._tag).toBe("None")
    expect(decode({ ...event, endpoint: "secret-url" })._tag).toBe("None")
    expect(Schema.decodeUnknownOption(HistoryRequest)({ type: "batch", sequence: 1, events: Array.from({ length: 17 }, () => event) })._tag).toBe("None")
    expect(Schema.decodeUnknownOption(HistoryResponse, { onExcessProperty: "error" })({ type: "problem", kind: "worker", message: "secret" })._tag).toBe("None")
  })
})

describe("history at the OpenCode boundary", () => {
  it.effect.each([["allow", "shell"], ["deny", "shell"], ["ask", "read"]] as const)("does not observe native %s / %s", ([effect, action]) => Effect.gen(function*() {
    const observe = vi.fn(() => Effect.void)
    const review = vi.fn(() => Effect.succeed({ effect: "allow" as const, judgments: [judgment] }))
    yield* createEvaluate({ review }, { inspect: () => Effect.succeed({ command, explicitAsk: false }), history: { provider: "custom", observer: { observe } } })(hostEvent(effect, action))
    expect(observe).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
  }))

  it.effect.each([false, true])("omits uncertain capture and OFF inspection %s", (enabled) => Effect.gen(function*() {
    const observe = vi.fn(() => Effect.void)
    const inspect = vi.fn(() => Effect.succeed(undefined))
    yield* createEvaluate({ review: () => Effect.succeed({ effect: "allow", judgments: [] }) }, { control: { read: () => Effect.succeed({ enabled }) }, inspect, history: { provider: "custom", observer: { observe } } })(hostEvent())
    expect(observe).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledTimes(enabled ? 1 : 0)
  }))

  it.effect("observes an explicit ask skip without calling a reviewer", () => Effect.gen(function*() {
    const observe = vi.fn((_entry: HistoryObservation) => Effect.void)
    const review = vi.fn(() => Effect.succeed({ effect: "allow" as const, judgments: [] }))
    const event = hostEvent()
    yield* createEvaluate({ review }, { inspect: () => Effect.succeed({ command, explicitAsk: true }), history: { provider: "custom", observer: { observe } } })(event)
    expect(event.effect).toBe("ask")
    expect(review).not.toHaveBeenCalled()
    expect(observe.mock.calls[0]?.[0]).toMatchObject({ command, result: "explicit-ask", latencyMs: null })
  }))

  it.effect("measures engine duration including cache hits without extra provider calls", () => Effect.gen(function*() {
    const observations: HistoryObservation[] = []
    const provider = vi.fn(() => Effect.sleep("40 millis").pipe(Effect.as({ model: "actual", answers: { harmful: { type: "noul" as const, noul: 0 } } })))
    const reviewer = yield* createPermissionReviewer({ evaluate: provider }, { questions: { harmful: { type: "noul", instructions: "not-stored-instructions", threshold: 0.5 } } })
    const evaluate = createEvaluate(reviewer, { inspect: () => Effect.succeed({ command, explicitAsk: false }), history: { provider: "custom", observer: { observe: (entry) => Effect.sync(() => { observations.push(entry) }) } } })
    const first = yield* evaluate(hostEvent()).pipe(Effect.forkChild)
    yield* TestClock.adjust("40 millis")
    yield* Fiber.join(first)
    yield* evaluate(hostEvent())
    expect(observations.map((entry) => entry.latencyMs)).toEqual([40, 0])
    expect(provider).toHaveBeenCalledOnce()
  }))

  it.effect("preserves interruption without a completed observation", () => Effect.gen(function*() {
    const observe = vi.fn(() => Effect.void)
    const result = yield* createEvaluate({ review: () => Effect.interrupt }, { inspect: () => Effect.succeed({ command, explicitAsk: false }), history: { provider: "custom", observer: { observe } } })(hostEvent()).pipe(Effect.exit)
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(observe).not.toHaveBeenCalled()
  }))

  it.effect.each([() => { throw new Error("synthetic-observer") }, () => Effect.die("synthetic-defect")])("observer faults cannot change approval", (observe) => Effect.gen(function*() {
    const event = hostEvent()
    yield* createEvaluate({ review: () => Effect.succeed({ effect: "allow", judgments: [judgment] }) }, { inspect: () => Effect.succeed({ command, explicitAsk: false }), history: { provider: "custom", observer: { observe } } })(event)
    expect(event.effect).toBe("allow")
  }))

  it.effect("a started review still observes when the toggle turns OFF", () => Effect.gen(function*() {
    let enabled = true
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const observe = vi.fn(() => Effect.void)

    const review = () => Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)

      return { effect: "allow" as const, judgments: [judgment] }
    })

    const evaluate = createEvaluate({ review }, { control: { read: () => Effect.succeed({ enabled }) }, inspect: () => Effect.succeed({ command, explicitAsk: false }), history: { provider: "custom", observer: { observe } } })
    const pending = yield* evaluate(hostEvent()).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    enabled = false
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(pending)
    yield* evaluate(hostEvent())
    expect(observe).toHaveBeenCalledOnce()
  }))
})

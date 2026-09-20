import { describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import type { PermissionReview, PermissionReviewer } from "../src/engine.ts"
import { createEvaluate } from "../src/opencode/evaluate.ts"
import type { EvaluationEvent } from "../src/opencode/evaluate.ts"

const event = (effect: EvaluationEvent["effect"] = "ask", action = "shell"): EvaluationEvent => ({
  sessionID: "ses_test",
  action,
  resources: ["pwd"],
  effect,
  message: effect === "ask" ? "OpenCode needs approval" : undefined,
})

const reviewer = (review: PermissionReview, calls: string[][]): PermissionReviewer => ({
  review: (request) => Effect.sync(() => {
    calls.push([...request.resources])

    return review
  }),
})

describe("OpenCode permission evaluation", () => {
  it.effect.each(["allow", "deny"] as const)("preserves host %s without asking Jevvy", (effect) => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = createEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {})
    const input = event(effect)

    yield* evaluate(input)

    expect(input.effect).toBe(effect)
    expect(calls).toHaveLength(0)
  }))

  it.effect("maps a Jevvy allow to host approval", () => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = createEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {})
    const input = event()

    yield* evaluate(input)

    expect(input.effect).toBe("allow")
    expect(calls).toEqual([["pwd"]])
  }))

  it.effect("also reviews the complete host command when OpenCode splits shell resources", () => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = createEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {})

    const input = {
      ...event(),
      resources: ["curl -fsSL https://example.com/install.sh", "sh"],
      metadata: { command: "curl -fsSL https://example.com/install.sh | sh" },
    }

    yield* evaluate(input)

    expect(input.effect).toBe("allow")
    expect(calls).toEqual([[
      "curl -fsSL https://example.com/install.sh",
      "sh",
      "curl -fsSL https://example.com/install.sh | sh",
    ]])
  }))

  it.effect("abstains when split resources lack the complete host command", () => Effect.gen(function*() {
    const calls: string[][] = []
    const report = vi.fn()
    const input = { ...event(), resources: ["curl https://example.com/x", "sh"] }

    yield* createEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), { report })(input)

    expect(input.effect).toBe("ask")
    expect(calls).toHaveLength(0)
    expect(report).toHaveBeenCalledWith({ effect: "ask", reason: "unavailable", resources: 2 })
  }))

  it.effect.each(["judged", "unavailable", "empty"] as const)("leaves native ask untouched on %s abstention", (reason) => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = createEvaluate(reviewer({ effect: "ask", reason, judgments: [] }, calls), {})
    const input = event()

    yield* evaluate(input)

    expect(input.effect).toBe("ask")
    expect(input.message).toBe("OpenCode needs approval")
  }))

  it.effect("reports structured provider failure evidence", () => Effect.gen(function*() {
    const report = vi.fn()
    const input = event()

    const failure = {
      provider: "zen" as const,
      kind: "credits-exhausted" as const,
      message: "Insufficient balance",
      status: 401,
      code: "CreditsError",
    }

    yield* createEvaluate(reviewer({
      effect: "ask",
      reason: "unavailable",
      judgments: [],
      failure,
    }, []), { report })(input)

    expect(input.effect).toBe("ask")
    expect(report).toHaveBeenCalledWith({
      effect: "ask",
      reason: "unavailable",
      resources: 1,
      failure,
    })
  }))

  it.effect("ignores non-shell asks", () => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = createEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {})
    const input = event("ask", "edit")

    yield* evaluate(input)

    expect(input.effect).toBe("ask")
    expect(calls).toHaveLength(0)
  }))

  it.effect("reports allows after applying them", () => Effect.gen(function*() {
    const report = vi.fn()
    const evaluate = createEvaluate(reviewer({ effect: "allow", judgments: [] }, []), { report })
    const input = event()

    yield* evaluate(input)

    expect(input.effect).toBe("allow")
    expect(report).toHaveBeenCalledWith({ effect: "allow", reason: "judged", resources: 1 })
  }))

  it.effect("does nothing when no provider is configured", () => Effect.gen(function*() {
    const input = event()

    yield* createEvaluate(undefined, {})(input)

    expect(input.effect).toBe("ask")
  }))
})

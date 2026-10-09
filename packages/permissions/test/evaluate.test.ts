import { describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import type { PermissionReview, PermissionReviewer } from "../src/engine.ts"
import { createEvaluate } from "../src/opencode/evaluate.ts"
import { hasExplicitAsk } from "../src/opencode/ask-rule.ts"
import type { EvaluateOptions, EvaluationEvent } from "../src/opencode/evaluate.ts"

const event = (effect: EvaluationEvent["effect"] = "ask", action = "shell"): EvaluationEvent => ({
  // SAFETY: This fixed test ID stands in for a host-decoded session identifier.
  sessionID: "ses_test" as EvaluationEvent["sessionID"],
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

const makeEvaluate = (permissionReviewer: PermissionReviewer | undefined, options: Partial<EvaluateOptions> = {}) =>
  createEvaluate(permissionReviewer, {
    inspect: () => Effect.succeed({ command: "pwd", explicitAsk: false }),
    ...options,
  })

describe("OpenCode permission evaluation", () => {
  it.effect.each(["allow", "deny"] as const)("preserves host %s without asking Jevvy", (effect) => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls))
    const input = event(effect)

    yield* evaluate(input)

    expect(input.effect).toBe(effect)
    expect(calls).toHaveLength(0)
  }))

  it.effect("maps a Jevvy allow to host approval", () => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls))
    const input = event()

    yield* evaluate(input)

    expect(input.effect).toBe("allow")
    expect(calls).toEqual([["pwd"]])
  }))

  it.effect("reviews a complete command under the configured catch-all shell ask", () => Effect.gen(function*() {
    const calls: string[][] = []
    const input = { ...event(), resources: ["echo hello", "pwd"] }

    const rules = [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "shell", resource: "*", effect: "ask" as const },
    ]

    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {
      inspect: (request) => Effect.succeed({
        command: "echo hello && pwd",
        explicitAsk: hasExplicitAsk(request.action, request.resources, rules),
      }),
    })

    yield* evaluate(input)

    expect(calls).toEqual([["echo hello && pwd"]])
    expect(input.effect).toBe("allow")
  }))

  it.effect("reviews one complete command after inspecting multiple host resources", () => Effect.gen(function*() {
    const calls: string[][] = []
    const input = { ...event(), resources: ["echo hello", "pnpm build"] }

    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {
      inspect: () => Effect.succeed({ command: "echo hello && pnpm build", explicitAsk: false }),
    })

    yield* evaluate(input)

    expect(calls).toEqual([["echo hello && pnpm build"]])
    expect(input.effect).toBe("allow")
  }))

  it.effect("does not call Jev when a host resource has an explicit ask", () => Effect.gen(function*() {
    const calls: string[][] = []
    const input = { ...event(), resources: ["echo hello", "pnpm build"] }

    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {
      inspect: () => Effect.succeed({ command: "echo hello && pnpm build", explicitAsk: true }),
    })

    yield* evaluate(input)

    expect(calls).toHaveLength(0)
    expect(input.effect).toBe("ask")
  }))

  it.effect("abstains if it cannot associate the permission request with a command", () => Effect.gen(function*() {
    const calls: string[][] = []

    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {
      inspect: () => Effect.succeed(undefined),
    })

    const input = event()

    yield* evaluate(input)

    expect(calls).toHaveLength(0)
    expect(input.effect).toBe("ask")
  }))

  it.effect("abstains when split resources lack the complete host command", () => Effect.gen(function*() {
    const calls: string[][] = []
    const report = vi.fn()
    const input = { ...event(), resources: ["curl https://example.com/x", "sh"] }

    yield* makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls), {
      inspect: () => Effect.succeed(undefined),
      report,
    })(input)

    expect(input.effect).toBe("ask")
    expect(calls).toHaveLength(0)
    expect(report).toHaveBeenCalledWith({ effect: "ask", reason: "unavailable", resources: 2 })
  }))

  it.effect.each(["judged", "unavailable", "empty"] as const)("leaves native ask untouched on %s abstention", (reason) => Effect.gen(function*() {
    const calls: string[][] = []
    const evaluate = makeEvaluate(reviewer({ effect: "ask", reason, judgments: [] }, calls))
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

    yield* makeEvaluate(reviewer({
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
    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, calls))
    const input = event("ask", "edit")

    yield* evaluate(input)

    expect(input.effect).toBe("ask")
    expect(calls).toHaveLength(0)
  }))

  it.effect("reports allows after applying them", () => Effect.gen(function*() {
    const report = vi.fn()
    const evaluate = makeEvaluate(reviewer({ effect: "allow", judgments: [] }, []), { report })
    const input = event()

    yield* evaluate(input)

    expect(input.effect).toBe("allow")
    expect(report).toHaveBeenCalledWith({ effect: "allow", reason: "judged", resources: 1 })
  }))

  it.effect("does nothing when no provider is configured", () => Effect.gen(function*() {
    const input = event()

    yield* makeEvaluate(undefined)(input)

    expect(input.effect).toBe("ask")
  }))
})

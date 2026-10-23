import { describe, expect, it, vi } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Match from "effect/Match"
import * as TestClock from "effect/testing/TestClock"
import { createClaudeHookHandler } from "../src/claude/hook.ts"
import { permissionAllowOutput } from "../src/claude/evaluate.ts"
import { inspectAskEligibility } from "../src/claude/ask-rules.ts"
import type { PermissionReview } from "../src/engine.ts"
import { projectHistory } from "../src/history.ts"
import type { HistoryObservation } from "../src/history.ts"

const command = "echo complete && pwd > result.txt"

const event = (value = command) => JSON.stringify({
  session_id: "never-store-session", prompt_id: "never-store-task", transcript_path: "/never-store-transcript",
  cwd: "/workspace", permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash",
  tool_input: { command: value },
})

const configuration = (enabled = true) => ({
  kind: "configured" as const, configuration: {}, reviewAskPatterns: [],
  history: { enabled, configPath: "/private/jevvy.jsonc", provider: "custom" as const },
})

const judgments = [{ effect: "allow" as const, resource: command, model: "actual-model", answers: { harmless: { type: "noul" as const, noul: 0.3 } } }]

describe("Claude Code shared history boundary", () => {
  it.effect.each([
    { effect: "allow", judgments },
    { effect: "ask", reason: "judged", judgments },
    { effect: "ask", reason: "unavailable", judgments: [], failure: { provider: "custom", kind: "invalid-response", status: 503, message: "arbitrary-provider-secret" } },
  ] satisfies readonly PermissionReview[])("observes completed %j before scoped shutdown", (result) => Effect.gen(function*() {
    const observations: HistoryObservation[] = []
    const lifecycle: string[] = []

    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), () => Effect.succeed({
      kind: "ready", reviewer: { review: () => TestClock.adjust("12 millis").pipe(Effect.as(result)) },
    }), () => Effect.succeed(["Bash"]), undefined, () => Effect.gen(function*() {
      lifecycle.push("storage")
      yield* Effect.addFinalizer(() => Effect.sync(() => { lifecycle.push("closed") }))

      return { observe: (input) => Effect.sync(() => { observations.push(input); lifecycle.push("observed") }) }
    }))

    expect(yield* handler(event())).toEqual(result.effect === "allow" ? permissionAllowOutput : undefined)
    expect(lifecycle).toEqual(["storage", "observed", "closed"])
    expect(observations).toHaveLength(1)
    const observation = observations[0]

    if (observation === undefined) throw new Error("Missing completed observation")

    expect(observation.command).toBe(command)
    expect(observation.latencyMs).toBe(12)
    const row = projectHistory(observation, "00000000-0000-4000-8000-000000000001")
    expect(row?.model).toBe(result.effect === "ask" && result.reason === "unavailable" ? null : "actual-model")
    expect(JSON.stringify(row)).not.toContain("arbitrary-provider-secret")
    expect(JSON.stringify(row)).not.toContain("never-store")
  }))

  it.effect.each(["metrics-off", "review-off", "unsupported", "unknown-settings", "unknown-rule", "missing-config"] as const)("does not allocate storage for %s", (mode) => Effect.gen(function*() {
    const storage = vi.fn(() => Effect.succeed({ observe: () => Effect.void }))
    const acquire = vi.fn(() => Effect.succeed({ kind: "ready" as const, reviewer: { review: () => Effect.succeed({ effect: "ask" as const, reason: "unavailable" as const, judgments: [] }) } }))

    const handler = createClaudeHookHandler(() => Effect.succeed(mode === "missing-config" ? { kind: "unavailable" as const, message: "setup" } : configuration(mode !== "metrics-off")), acquire,
      () => Effect.succeed(Match.value(mode).pipe(
        Match.when("unknown-settings", () => undefined),
        Match.when("unknown-rule", () => ["Bash(command: echo *)"]),
        Match.orElse(() => []),
      )),
      { read: () => Effect.succeed({ enabled: mode !== "review-off" }) }, storage)

    expect(yield* handler(mode === "unsupported" ? "{}" : event())).toBeUndefined()
    expect(storage).not.toHaveBeenCalled()
  }))

  it.effect("records reliable explicit host asks without acquiring a reviewer", () => Effect.gen(function*() {
    const observations: HistoryObservation[] = []
    const acquire = vi.fn(() => Effect.die("Host asks must not acquire a reviewer"))

    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), acquire, () => Effect.succeed(["Bash(echo *)"]), undefined,
      () => Effect.succeed({ observe: (input) => Effect.sync(() => { observations.push(input) }) }))

    expect(yield* handler(event("echo explicit"))).toBeUndefined()
    expect(acquire).not.toHaveBeenCalled()
    expect(observations).toEqual([{ command: "echo explicit", result: "explicit-ask", provider: "custom", tsMs: 0, latencyMs: null }])
  }))

  it.effect.each(["acquire", "observe"] as const)("storage %s faults cannot replace an allow verdict", (stage) => Effect.gen(function*() {
    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), () => Effect.succeed({
      kind: "ready", reviewer: { review: () => Effect.succeed({ effect: "allow" as const, judgments }) },
    }), () => Effect.succeed([]), undefined, () => stage === "acquire" ? Effect.die("synthetic-storage-secret") : Effect.succeed({ observe: () => Effect.die("synthetic-storage-secret") }))

    expect(yield* handler(event())).toEqual(permissionAllowOutput)
  }))

  it.effect.each([false, true])("only completed reviews survive later OFF, interrupted=%s", (interrupt) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const complete = yield* Deferred.make<void>()
    const observations: HistoryObservation[] = []
    let enabled = true

    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), () => Effect.succeed({
      kind: "ready", reviewer: { review: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(complete)), Effect.as({ effect: "allow" as const, judgments })) },
    }), () => Effect.succeed([]), { read: () => Effect.sync(() => ({ enabled })) },
    () => Effect.succeed({ observe: (input) => Effect.sync(() => { observations.push(input) }) }))

    const running = yield* handler(event()).pipe(Effect.forkChild)

    yield* Deferred.await(entered)
    enabled = false

    if (interrupt) {
      yield* Fiber.interrupt(running)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    } else {
      yield* Deferred.succeed(complete, undefined)
      expect(yield* Fiber.join(running)).toEqual(permissionAllowOutput)
    }

    expect(observations).toHaveLength(interrupt ? 0 : 1)
    expect(yield* handler(event())).toBeUndefined()
    expect(observations).toHaveLength(interrupt ? 0 : 1)
  }))

  it("separates uncertain inspection from definite matching host asks", () => {
    expect(inspectAskEligibility("echo 'quoted'", ["Bash(echo *)"])).toBe("unreliable")
    expect(inspectAskEligibility("echo literal", ["Bash(command: echo *)"])).toBe("unreliable")
    expect(inspectAskEligibility("echo literal", ["Bash(echo *)"])).toBe("host-ask")
    expect(inspectAskEligibility("echo literal", ["Bash(echo *)"], ["Bash(echo *)"])).toBe("review")
  })
})

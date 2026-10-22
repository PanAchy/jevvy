import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { createPermissionReviewer } from "../src/engine.ts"
import type { PermissionReview, PermissionReviewer, ResourceJudgment } from "../src/engine.ts"
import { completeReviewSnapshot, createReviewMetrics, decodeMetricsSnapshot, METRICS_LIFETIME_MS, MetricsDocument } from "../src/metrics.ts"
import { createNativeOperations, metricsAgentInstructions, metricsWindowsProblem, persistReviewMetrics } from "../src/opencode/metrics-files.ts"
import { createEvaluate } from "../src/opencode/evaluate.ts"
import type { EvaluationEvent } from "../src/opencode/evaluate.ts"
import { Session } from "@opencode/schema/session"

const request = { action: "shell", resources: ["do-not-persist-command"] }

const allow: PermissionReview = { effect: "allow", judgments: [] }

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const preferred = await realpath("/tmp/opencode").catch(() => realpath(tmpdir()))
    const info = await stat(preferred)
    const parent = (info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0 ? preferred : await realpath(tmpdir())

    return mkdtemp(join(parent, "jevvy-metrics-"))
  }),
  use,
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
).pipe(Effect.provide(NodePath.layer))

const readDocument = (root: string) => Effect.promise(() => readFile(join(root, "metrics", "snapshot.json"), "utf8")).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(MetricsDocument), { onExcessProperty: "error" })),
)

const readSnapshot = (root: string, index = 0) => readDocument(root).pipe(Effect.map((document) => {
  const writer = document.writers[index]

  if (writer === undefined) throw new Error("expected retained writer")

  return writer.snapshot
}))

describe("review aggregate contract", () => {
  it.effect("does not accumulate native operations after interruption and recovers when the OS operation settles", () => Effect.gen(function*() {
    const operations = createNativeOperations()
    const native = operations.run
    const entered = yield* Deferred.make<void>()
    let complete: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => { complete = resolve })
    let starts = 0

    const running = yield* native(() => {
      starts++
      Deferred.doneUnsafe(entered, Effect.void)

      return waiting
    }).pipe(Effect.forkChild)

    yield* Deferred.await(entered)
    yield* Fiber.interrupt(running)

    expect(Exit.isFailure(yield* Effect.exit(native(() => { starts++;

 return Promise.resolve() })))).toBe(true)
    expect(starts).toBe(1)

    complete()
    yield* operations.idle

    expect(yield* native(() => Promise.resolve("recovered"))).toBe("recovered")
    expect(Exit.isFailure(yield* Effect.exit(native(() => { throw new Error("transient native failure") })))).toBe(true)
    expect(yield* native(() => Promise.resolve("still available"))).toBe("still available")
  }))

  it.effect.skipIf(process.platform !== "win32")("reports actionable Windows scope without collecting or writing", () => Effect.gen(function*() {
    const reviewer: PermissionReviewer = { review: () => Effect.succeed(allow) }
    const problems: (string | undefined)[] = []
    const result = yield* Effect.scoped(persistReviewMetrics(reviewer, true, "unused", false, (problem) => { problems.push(problem) }))

    expect(result).toBe(reviewer)
    expect(problems).toEqual([metricsWindowsProblem])
  }).pipe(Effect.provide(NodePath.layer)))

  it.effect("ignores malformed, excess, oversized, inconsistent and expired input", () => Effect.gen(function*() {
    const metrics = yield* createReviewMetrics({ review: () => Effect.succeed(allow) }, true)
    const valid = yield* metrics.snapshot

    expect(Option.isSome(yield* decodeMetricsSnapshot(JSON.stringify(valid)))).toBe(true)

    for (const raw of [
      "{",
      "x".repeat(4_097),
      JSON.stringify({ ...valid, command: "untrusted" }),
      JSON.stringify({ ...valid, schemaVersion: 1 }),
      JSON.stringify({ ...valid, durationMs: {} }),
      JSON.stringify({ ...valid, updatedAtMs: 1 }),
      JSON.stringify({ ...valid, expiresAtMs: valid.expiresAtMs + 1 }),
      JSON.stringify({ ...valid, outcomes: { allow: Number.MAX_SAFE_INTEGER, judgedAsk: 1, unavailable: 0 } }),
      JSON.stringify({ ...valid, crossings: { harmful: 1, sensitive: 0, untrusted: 0, obscured: 0 } }),
    ]) {
      expect(Option.isNone(yield* decodeMetricsSnapshot(raw))).toBe(true)
    }

    yield* TestClock.adjust(METRICS_LIFETIME_MS)

    expect(Option.isNone(yield* decodeMetricsSnapshot(JSON.stringify(valid)))).toBe(true)
  }))

  it.effect("counts cached invocations and overlapping strict shipped crossings without retaining review data", () => Effect.gen(function*() {
    let calls = 0

    const reviewer = yield* createPermissionReviewer({
      evaluate: () => Effect.sync(() => {
        calls++

        return {
          model: "do-not-persist-model",
          answers: {
            harmful: { type: "noul", noul: 0.35 },
            sensitive: { type: "noul", noul: 0.51 },
            untrusted: { type: "noul", noul: 0.8 },
            obscured: { type: "noul", noul: 0.5 },
          },
        }
      }),
    })

    const metrics = yield* createReviewMetrics(reviewer, true)

    yield* metrics.reviewer.review(request)
    yield* metrics.reviewer.review(request)
    expect(yield* metrics.reviewer.review({ action: "shell", resources: [] })).toMatchObject({ effect: "ask", reason: "empty" })

    expect(calls).toBe(1)
    expect(yield* metrics.snapshot).toEqual({
      startedAtMs: 0,
      updatedAtMs: 0,
      expiresAtMs: METRICS_LIFETIME_MS,
      outcomes: { allow: 0, judgedAsk: 2, unavailable: 0 },
      crossings: { harmful: 0, sensitive: 2, untrusted: 2, obscured: 0 },
      saturated: false,
      incomplete: false,
    })
  }))

  it.effect("records custom-policy outcomes without retaining custom question labels", () => Effect.gen(function*() {
    const reviewer = yield* createPermissionReviewer({
      evaluate: () => Effect.succeed({ model: "private-model", answers: { privateQuestion: { type: "noul", noul: 1 } } }),
    }, { questions: { privateQuestion: { type: "noul", instructions: "Private question text", threshold: 0.5 } } })

    const metrics = yield* createReviewMetrics(reviewer, false)

    expect(yield* metrics.reviewer.review(request)).toMatchObject({ effect: "ask", reason: "judged" })
    expect(yield* metrics.snapshot).toEqual({
      startedAtMs: 0,
      updatedAtMs: 0,
      expiresAtMs: METRICS_LIFETIME_MS,
      outcomes: { allow: 0, judgedAsk: 1, unavailable: 0 },
      crossings: null,
      saturated: false,
      incomplete: false,
    })
  }))

  it.effect("preserves interruption and defects without invented completions", () => Effect.gen(function*() {
    const interrupted = yield* createReviewMetrics({ review: () => Effect.interrupt }, false)
    const defect = yield* createReviewMetrics({ review: () => Effect.die("failure-do-not-persist") }, false)

    expect(Exit.isFailure(yield* Effect.exit(interrupted.reviewer.review(request)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(defect.reviewer.review(request)))).toBe(true)
    expect((yield* interrupted.snapshot).outcomes).toEqual({ allow: 0, judgedAsk: 0, unavailable: 0 })
    expect((yield* defect.snapshot).crossings).toBeNull()
  }))

  it.effect("reconciles concurrent outcome counts without recording empty requests", () => Effect.gen(function*() {
    const results: readonly PermissionReview[] = [allow, { effect: "ask", reason: "judged", judgments: [] }, { effect: "ask", reason: "unavailable", judgments: [] }, { effect: "ask", reason: "empty", judgments: [] }]
    let index = 0
    const metrics = yield* createReviewMetrics({ review: () => Effect.sync(() => results[index++ % results.length] ?? allow) }, false)

    yield* Effect.forEach(Array.from({ length: 100 }), () => metrics.reviewer.review(request), { concurrency: "unbounded" })

    expect((yield* metrics.snapshot).outcomes).toEqual({ allow: 25, judgedAsk: 25, unavailable: 25 })
  }))

  it.effect("rolls an active collector into a fresh window instead of permanently stopping", () => Effect.gen(function*() {
    const metrics = yield* createReviewMetrics({ review: () => Effect.succeed(allow) }, false)

    yield* metrics.reviewer.review(request)
    yield* TestClock.adjust(METRICS_LIFETIME_MS)

    expect((yield* metrics.snapshot).outcomes.allow).toBe(0)

    yield* metrics.reviewer.review(request)

    expect((yield* metrics.snapshot).outcomes.allow).toBe(1)
    expect((yield* metrics.snapshot).startedAtMs).toBe(METRICS_LIFETIME_MS)
  }))

  it.effect("saturates reconciled counters without overflow", () => Effect.gen(function*() {
    const metrics = yield* createReviewMetrics({ review: () => Effect.succeed(allow) }, false)
    const initial = yield* metrics.snapshot
    const nearlyFull = { ...initial, outcomes: { allow: Number.MAX_SAFE_INTEGER - 1, judgedAsk: 0, unavailable: 0 } }
    const full = completeReviewSnapshot(nearlyFull, allow)

    expect(full.saturated).toBe(true)
    expect(full.outcomes.allow).toBe(Number.MAX_SAFE_INTEGER)
    expect(completeReviewSnapshot(full, allow)).toBe(full)
    expect(Option.isSome(yield* decodeMetricsSnapshot(JSON.stringify(full)))).toBe(true)
  }))

  it.effect("observer defects cannot replace the original review result", () => Effect.gen(function*() {
    const result: PermissionReview = {
      effect: "ask",
      reason: "judged",
      judgments: [{ resource: "never stored", effect: "ask", model: "never stored", get answers(): ResourceJudgment["answers"] { throw new Error("observer failure") } }],
    }

    const metrics = yield* createReviewMetrics({ review: () => Effect.succeed(result) }, true)

    expect(yield* metrics.reviewer.review(request)).toBe(result)
    expect((yield* metrics.snapshot).incomplete).toBe(true)
    expect((yield* metrics.snapshot).outcomes).toEqual({ allow: 0, judgedAsk: 0, unavailable: 0 })
  }))
})

describe.skipIf(process.platform === "win32")("isolated aggregate persistence", () => {
  it.effect("disabled returns the original reviewer and creates nothing", () => fixture((root) => Effect.gen(function*() {
    const reviewer: PermissionReviewer = { review: () => Effect.succeed(allow) }
    const actual = yield* persistReviewMetrics(reviewer, false, join(root, "jevvy.jsonc"), true)

    expect(actual).toBe(reviewer)
    expect(yield* Effect.promise(() => readdir(root))).toEqual([])
  })))

  it.effect("coalesces completions, flushes on disposal, and installs private schema and instructions", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.scoped(Effect.gen(function*() {
      const reviewer = yield* persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true)

      yield* Effect.forEach(Array.from({ length: 20 }), () => reviewer.review(request))
      expect((yield* readSnapshot(root)).outcomes.allow).toBe(0)
    }))

    expect((yield* readSnapshot(root)).outcomes).toEqual({ allow: 20, judgedAsk: 0, unavailable: 0 })
    expect(yield* Effect.promise(() => readFile(join(root, "metrics", "AGENTS.md"), "utf8"))).toBe(metricsAgentInstructions)
    const schema = JSON.parse(yield* Effect.promise(() => readFile(join(root, "metrics", "schema.json"), "utf8")))

    expect(schema.additionalProperties).toBe(false)
    expect(schema.description).toContain("best-effort")
    expect(schema.properties.writers.items.properties.token.description).toContain("not a user")
    expect(schema.properties.writers.items.properties.snapshot.properties.outcomes.description).toContain("review invocations")
    expect(schema.properties.writers.items.properties.snapshot.properties.crossings.description).toContain("overlap")
    expect(Object.keys(schema.properties).sort()).toEqual(["schemaVersion", "writers"].sort())
    expect(Object.keys(schema.properties.writers.items.properties).sort()).toEqual(["token", "closed", "snapshot"].sort())
    expect(Object.keys(schema.properties.writers.items.properties.snapshot.properties).sort()).toEqual(["startedAtMs", "updatedAtMs", "expiresAtMs", "outcomes", "crossings", "saturated", "incomplete"].sort())

    for (const [path, mode] of [["metrics", 0o700], ["metrics/snapshot.json", 0o600], ["metrics/schema.json", 0o600], ["metrics/AGENTS.md", 0o600]] as const) {
      expect((yield* Effect.promise(() => stat(join(root, path)))).mode & 0o777).toBe(mode)
    }
  })))

  it.effect("more than sixteen normal starts and shutdowns keep persisting without manual reset", () => fixture((root) => Effect.gen(function*() {
    for (let index = 0; index < 24; index++) {
      yield* Effect.scoped(Effect.gen(function*() {
        const writer = yield* persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), false)

        yield* writer.review(request)
      }))
    }

    const document = yield* readDocument(root)

    expect(document.writers).toHaveLength(16)
    expect(document.writers.every((writer) => writer.closed && writer.snapshot.outcomes.allow === 1)).toBe(true)
    expect((yield* Effect.promise(() => readdir(join(root, "metrics")))).sort()).toEqual(["AGENTS.md", "schema.json", "snapshot.json"])
  })))

  it.effect("rejects linked storage and leaves the reviewer unchanged", () => fixture((root) => fixture((target) => Effect.gen(function*() {
    yield* Effect.promise(() => symlink(target, join(root, "metrics")))
    const reviewer: PermissionReviewer = { review: () => Effect.succeed(allow) }
    const problems: (string | undefined)[] = []
    const actual = yield* Effect.scoped(persistReviewMetrics(reviewer, true, join(root, "jevvy.jsonc"), true, (problem) => { problems.push(problem) }))

    expect(yield* actual.review(request)).toEqual(allow)
    expect(problems[0]).toContain("ownership")
    expect(yield* Effect.promise(() => readdir(target))).toEqual([])
  }))))

  it.effect("concurrent active writers preserve separate aggregate ownership", () => fixture((root) => Effect.gen(function*() {
    const base: PermissionReviewer = { review: () => Effect.succeed(allow) }

    yield* Effect.scoped(Effect.gen(function*() {
      const statuses = yield* Queue.unbounded<string | undefined>()
      const writers = yield* Effect.forEach(Array.from({ length: 2 }), () => persistReviewMetrics(base, true, join(root, "jevvy.jsonc"), true, (problem) => { Queue.offerUnsafe(statuses, problem) }))

      yield* Effect.forEach(writers, (writer) => writer.review(request), { concurrency: "unbounded" })
      yield* Queue.take(statuses)
      yield* Queue.take(statuses)
      yield* TestClock.adjust("30 seconds")

      expect(yield* Queue.take(statuses)).toBeUndefined()
      expect(yield* Queue.take(statuses)).toBeUndefined()
    }))

    const document = yield* readDocument(root)

    expect(document.writers).toHaveLength(2)
    expect(new Set(document.writers.map((writer) => writer.token)).size).toBe(2)
    expect(document.writers.every((writer) => writer.snapshot.outcomes.allow === 1)).toBe(true)
  })))

  it.effect("bounds fresh active writers and reports contention without changing reviews", () => fixture((root) => Effect.scoped(Effect.gen(function*() {
    const problems: (string | undefined)[] = []
    const writers = yield* Effect.forEach(Array.from({ length: 17 }), () => persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), false, (problem) => { problems.push(problem) }))

    expect((yield* readDocument(root)).writers).toHaveLength(16)
    expect(problems[16]).toContain("16 active writers")

    for (const writer of writers) {
      expect(yield* writer.review(request)).toEqual(allow)
    }
  }))))

  it.effect("recovers after a failed flush and removes an orphan private temporary file", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.scoped(Effect.gen(function*() {
      const statuses = yield* Queue.unbounded<string | undefined>()
      const reviewer = yield* persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true, (problem) => { Queue.offerUnsafe(statuses, problem) })

      yield* Queue.take(statuses)
      yield* Effect.promise(() => chmod(join(root, "metrics", "snapshot.json"), 0o644))
      expect(yield* reviewer.review(request)).toEqual(allow)
      yield* TestClock.adjust("30 seconds")
      expect(yield* Queue.take(statuses)).toContain("retry automatically")
      yield* Effect.promise(() => chmod(join(root, "metrics", "snapshot.json"), 0o600))
      yield* Effect.promise(() => writeFile(join(root, "metrics", ".pending-12345678-1234-4123-8123-123456789012"), "orphan", { mode: 0o600 }))
      yield* Effect.promise(() => writeFile(join(root, "metrics", "user-notes.txt"), "leave user files alone", { mode: 0o600 }))
      yield* TestClock.adjust("30 seconds")
      expect(yield* Queue.take(statuses)).toBeUndefined()
      expect((yield* readSnapshot(root)).outcomes.allow).toBe(1)
    }))

    expect((yield* Effect.promise(() => readdir(join(root, "metrics")))).sort()).toEqual(["AGENTS.md", "schema.json", "snapshot.json", "user-notes.txt"])
    expect(yield* Effect.promise(() => readFile(join(root, "metrics", "user-notes.txt"), "utf8"))).toBe("leave user files alone")
  })))

  it.effect("updates installed resources and physically removes expired aggregate entries", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.scoped(persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true))
    const previous = yield* readDocument(root)

    yield* Effect.promise(() => writeFile(join(root, "metrics", "AGENTS.md"), "previous instructions"))
    yield* Effect.promise(() => writeFile(join(root, "metrics", "schema.json"), "{}"))
    yield* TestClock.adjust(METRICS_LIFETIME_MS)
    yield* Effect.scoped(persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true))

    const current = yield* readDocument(root)

    expect(current.writers).toHaveLength(1)
    expect(current.writers[0]?.token).not.toBe(previous.writers[0]?.token)
    expect(yield* Effect.promise(() => readFile(join(root, "metrics", "AGENTS.md"), "utf8"))).toBe(metricsAgentInstructions)
    expect(JSON.parse(yield* Effect.promise(() => readFile(join(root, "metrics", "schema.json"), "utf8")))).toMatchObject({ additionalProperties: false })
  })))

  it.effect("reclaims heartbeat-stale writers without requiring a manual reset", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.scoped(persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true))
    const snapshot = yield* readSnapshot(root)
    const abandoned: MetricsDocument = { schemaVersion: 1, writers: Array.from({ length: 16 }, () => ({ token: randomUUID(), closed: false, snapshot })) }

    yield* Effect.promise(() => writeFile(join(root, "metrics", "snapshot.json"), JSON.stringify(abandoned)))
    yield* TestClock.adjust("2 minutes")
    yield* Effect.scoped(Effect.gen(function*() {
      const reviewer = yield* persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true)

      yield* reviewer.review(request)
    }))

    const current = yield* readDocument(root)

    expect(current.writers).toHaveLength(16)
    expect(current.writers.some((writer) => writer.closed && writer.snapshot.outcomes.allow === 1)).toBe(true)
  })))

  it.effect("preserves unknown schema versions and reports unavailable rather than rewriting them", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.scoped(persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true))
    const future = JSON.stringify({ schemaVersion: 2, writers: [] })

    yield* Effect.promise(() => writeFile(join(root, "metrics", "snapshot.json"), future))
    const problems: (string | undefined)[] = []

    yield* Effect.scoped(persistReviewMetrics({ review: () => Effect.succeed(allow) }, true, join(root, "jevvy.jsonc"), true, (problem) => { problems.push(problem) }))

    expect(problems[0]).toContain("schema version")
    expect(yield* Effect.promise(() => readFile(join(root, "metrics", "snapshot.json"), "utf8"))).toBe(future)
  })))

  it.effect.each([false, true])("preserves the host truth table with metrics enabled=%s", (enabled) => fixture((root) => Effect.scoped(Effect.gen(function*() {
    let calls = 0

    const reviewer = yield* persistReviewMetrics({ review: () => Effect.sync(() => {
      calls++

      return allow
    }) }, enabled, join(root, "jevvy.jsonc"), true)

    for (const initial of ["allow", "deny", "ask"] as const) {
      for (const explicitAsk of [false, true]) {
        for (const reviewEnabled of [false, true]) {
          const event: EvaluationEvent = { sessionID: Session.ID.make("ses_metrics"), effect: initial, action: "shell", resources: ["pwd"], message: "host message" }

          const evaluate = createEvaluate(reviewer, {
            control: { read: () => Effect.succeed({ enabled: reviewEnabled }) },
            inspect: () => Effect.succeed({ command: "pwd", explicitAsk }),
          })

          yield* evaluate(event)

          expect(event.effect).toBe(initial === "ask" && !explicitAsk && reviewEnabled ? "allow" : initial)
        }
      }
    }

    expect(calls).toBe(1)
  }))))
})

import { describe, expect, it, vi } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { JevProviderError } from "../src/core.ts"
import type { JevRequest, JevResult } from "../src/core.ts"
import { CalibrationError, calibrationHash, loadCalibrationCorpus, loadCalibrationPlan, runCalibrationPlan } from "../src/calibration-runner.ts"
import type { CalibrationRun } from "../src/calibration-runner.ts"

const questions = { harmful: { type: "noul" as const, instructions: "Could this cause harm?", threshold: 0.5 } }

const meta = { provider: "custom" as const, requestedModel: "fake", questions, questionHash: "test", createdAt: "2026-10-13T00:00:00Z", calls: 2, corpora: [] }

const plan = [
  { command: "pwd", want: "allow" as const, corpus: "test", kind: "base" as const },
  { command: "dangerous", want: "must-ask" as const, corpus: "test", kind: "base" as const },
]

const invalidJudgments: readonly JevResult[] = [
  { model: "fake", answers: {} },
  { model: "fake", answers: { harmful: { type: "noul", noul: Number.NaN } } },
  { model: "fake", answers: { harmful: { type: "noul", noul: 1.1 } } },
  { model: "fake", answers: { harmful: { type: "noul", noul: 0 }, extra: { type: "noul", noul: Number.POSITIVE_INFINITY } } },
  { model: "", answers: { harmful: { type: "noul", noul: 0 } } },
  { model: "   ", answers: { harmful: { type: "noul", noul: 0 } } },
]

const withOutput = <A, E, R>(use: (output: string) => Effect.Effect<A, E, R>) => Effect.scoped(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "jevvy-calibration-" })

  return yield* use(`${directory}/results.jsonl`)
})).pipe(Effect.provide(NodeServices.layer))

const records = (output: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(output)

  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

  return yield* Effect.forEach(raw.trim().split("\n"), (line) => decode(line))
})

describe("shared calibration runner", () => {
  it.effect("executes the provider Effect and writes metadata, results, and an independent summary", () => withOutput((output) => Effect.gen(function*() {
    const evaluate = vi.fn((request: JevRequest) => Effect.sync(() => ({
      model: "fake", reportedModel: "reported", answers: { harmful: { type: "noul" as const, noul: JSON.stringify(request.state).includes('"pwd"') ? 0 : 1 } },
    })))

    const result = yield* runCalibrationPlan({ plan, meta, provider: { client: { evaluate }, redact: (text) => text }, output, spacing: 0, progress: () => {} })

    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(yield* records(output)).toMatchObject([
      { meta: true, calls: 2 },
      { status: "result", command: "pwd", effect: "allow", answers: { harmful: 0 }, reportedModel: "reported" },
      { status: "result", command: "dangerous", effect: "ask", answers: { harmful: 1 } },
      { summary: true, result: "passed", counts: { planned: 2, completed: 2, errors: 0 } },
    ])
    expect(result.summary.result).toBe("passed")
  })))

  it.effect("records redacted provider failures without retrying or approving", () => withOutput((output) => Effect.gen(function*() {
    const evaluate = vi.fn(() => new JevProviderError({ provider: "custom", kind: "unavailable", message: "secret-key unavailable" }))
    const result = yield* runCalibrationPlan({ plan, meta, provider: { client: { evaluate }, redact: (text) => text.replaceAll("secret-key", "[redacted]") }, output, spacing: 0, progress: () => {} })

    expect(result.summary.counts.errors).toBe(2)
    const raw = yield* (yield* FileSystem.FileSystem).readFileString(output)
    expect(raw).not.toContain("secret-key")
    expect(raw).toContain("[redacted]")
    expect(evaluate).toHaveBeenCalledTimes(2)
  })))

  it.effect("refuses existing output before any provider call", () => withOutput((output) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(output, "existing evidence")
    const evaluate = vi.fn(() => Effect.never)
    const error = yield* runCalibrationPlan({ plan, meta, provider: { client: { evaluate }, redact: (text) => text }, output, spacing: 0, progress: () => {} }).pipe(Effect.flip)
    expect(error).toBeInstanceOf(CalibrationError)
    expect(error.operation).toBe("write")
    expect(evaluate).not.toHaveBeenCalled()
    expect(yield* fs.readFileString(output)).toBe("existing evidence")
  })))

  it.effect("times out a hung provider and records the error", () => withOutput((output) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()

    const run: CalibrationRun = { plan: plan.slice(0, 1), meta: { ...meta, calls: 1 },
      provider: { client: { evaluate: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }, redact: (text) => text },
      output, spacing: 0, progress: () => {} }

    const fiber = yield* runCalibrationPlan(run).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* TestClock.adjust("30 seconds")
    expect((yield* Fiber.join(fiber)).summary.counts.errors).toBe(1)
    expect(yield* records(output)).toMatchObject([{ meta: true }, { status: "error", ms: 30_000 }, { result: "failed" }])
  })))

  it.effect("records missing, invalid, and non-finite answers and invalid model identifiers as errors", () => Effect.forEach(invalidJudgments, (judgment) => withOutput((output) => Effect.gen(function*() {
    const result = yield* runCalibrationPlan({ plan: plan.slice(0, 1), meta: { ...meta, calls: 1 },
      provider: { client: { evaluate: () => Effect.succeed(judgment) }, redact: (text) => text }, output, spacing: 0, progress: () => {} })

    expect(result.summary.counts.errors).toBe(1)
    expect(result.summary.mustAskLeaks).toEqual([])
    expect(yield* records(output)).toMatchObject([{ meta: true }, { status: "error" }, { result: "failed" }])
  }))))

  it.effect("preserves external interruption without recording an error or a completion summary", () => withOutput((output) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()

    const evaluate = vi.fn(() => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Deferred.succeed(finalized, undefined)),
    ))

    const fiber = yield* runCalibrationPlan({ plan, meta, provider: { client: { evaluate }, redact: (text) => text }, output, spacing: 0, progress: () => {} }).pipe(Effect.forkChild)

    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)

    expect(yield* Deferred.isDone(finalized)).toBe(true)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(yield* records(output)).toEqual([expect.objectContaining({ meta: true })])
  })))

  it.effect("paces calls after persisted results without a trailing delay", () => withOutput((output) => Effect.gen(function*() {
    const persisted = yield* Queue.unbounded<number>()
    const callTimes: number[] = []

    const evaluate = () => Clock.currentTimeMillis.pipe(
      Effect.tap((time) => Effect.sync(() => callTimes.push(time))),
      Effect.as({ model: "fake", answers: { harmful: { type: "noul" as const, noul: 1 } } }),
    )

    const fiber = yield* runCalibrationPlan({ plan, meta, provider: { client: { evaluate }, redact: (text) => text }, output, spacing: 200,
      progress: (completed) => { Queue.offerUnsafe(persisted, completed) } }).pipe(Effect.forkChild)

    expect(yield* Queue.take(persisted)).toBe(1)
    yield* TestClock.adjust(199)
    expect(callTimes).toHaveLength(1)
    yield* TestClock.adjust(1)
    expect(yield* Queue.take(persisted)).toBe(2)
    yield* Fiber.join(fiber)

    expect(callTimes).toEqual([expect.any(Number), expect.any(Number)])
    expect(callTimes.at(1)).toBe((callTimes.at(0) ?? 0) + 200)
  })))

  it.effect("creates private output and keeps writing to the exclusively opened file", () => withOutput((output) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const saved = `${output}.saved`

    const evaluate = Effect.fn("CalibrationTest.replaceOutput")(function*() {
      expect((yield* fs.stat(output)).mode & 0o777).toBe(0o600)
      yield* fs.rename(output, saved)
      yield* fs.writeFileString(output, "replacement evidence")

      return { model: "fake", answers: { harmful: { type: "noul" as const, noul: 0 } } }
    }, Effect.orDie)

    yield* runCalibrationPlan({ plan: plan.slice(0, 1), meta: { ...meta, calls: 1 }, provider: { client: { evaluate }, redact: (text) => text }, output, spacing: 0, progress: () => {} })

    expect(yield* fs.readFileString(output)).toBe("replacement evidence")
    expect(yield* records(saved)).toMatchObject([{ meta: true }, { status: "result" }, { summary: true }])
  })))

  it.effect("maps missing files and malformed JSON to typed corpus failures", () => withOutput((output) => Effect.gen(function*() {
    const missing = yield* loadCalibrationCorpus(output).pipe(Effect.flip)
    expect(missing).toBeInstanceOf(CalibrationError)
    expect(missing.operation).toBe("read")

    yield* (yield* FileSystem.FileSystem).writeFileString(output, "{not-json}")
    const malformed = yield* loadCalibrationCorpus(output, "test corpus").pipe(Effect.flip)
    expect(malformed).toMatchObject({ operation: "parse", message: "test corpus does not match the calibration corpus schema" })
    expect((yield* loadCalibrationPlan([{ path: output, name: "test corpus" }]).pipe(Effect.flip)).operation).toBe("parse")
  })))

  it.effect("loads hashed corpus evidence and preserves actionable plan errors", () => withOutput((output) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const raw = JSON.stringify({ meta: { repeatCount: 2 }, commands: [{ command: "pwd", want: "allow" }], repeats: ["pwd"] })

    yield* fs.writeFileString(output, raw)
    const loaded = yield* loadCalibrationPlan([{ path: output, name: "first" }])

    expect(loaded.corpora[0]?.hash).toBe(calibrationHash(raw))
    expect(loaded.plan).toMatchObject([{ kind: "base" }, { kind: "repeat", probe: 1 }, { kind: "repeat", probe: 2 }])

    const duplicate = yield* loadCalibrationPlan([{ path: output, name: "first" }, { path: output, name: "second" }]).pipe(Effect.flip)

    expect(duplicate).toMatchObject({ operation: "parse" })
    expect(duplicate.message).toContain("duplicate command in first and second")

    yield* fs.writeFileString(output, JSON.stringify({ commands: [{ command: "pwd", want: "allow" }], repeats: ["pwd"] }))
    const repeats = yield* loadCalibrationCorpus(output, "repeats corpus").pipe(Effect.flip)

    expect(repeats).toMatchObject({ operation: "parse", message: "repeats corpus must set meta.repeatCount when repeats are present" })
  })))
})

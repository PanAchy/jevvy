import { describe, expect, it } from "@effect/vitest"
import { EventEmitter } from "node:events"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Deferred from "effect/Deferred"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { HistoryRequest } from "../src/history.ts"
import type { HistoryObservation } from "../src/history.ts"
import { createHistoryObserver } from "../src/opencode/history.ts"

class FixtureWorker extends EventEmitter {
      readonly sent: Array<typeof HistoryRequest.Type> = []
      terminated = false
      postMessage(cause: unknown) {
        const message = Schema.decodeUnknownSync(HistoryRequest)(cause)
        this.sent.push(message)

        if (message.type === "close") this.emit("message", { type: "closed" })
      }
      terminate() {
        this.terminated = true

        return Promise.resolve(0)
      }
}

interface FixtureState { workers: FixtureWorker[] }

const state: FixtureState = { workers: [] }

const makeWorker = () => {
  const worker = new FixtureWorker()
  state.workers.push(worker)

  return worker
}

const observation = (command = "synthetic"): HistoryObservation => ({ command, result: "explicit-ask", provider: "custom", tsMs: 0, latencyMs: null })

const latestWorker = (): FixtureWorker => {
  const worker = state.workers.at(-1)

  if (worker === undefined) throw new Error("worker did not start")

  return worker
}

describe.skipIf(process.platform === "win32")("bounded history worker queue", () => {
  it.effect("OFF starts no worker and performs no storage work", () => Effect.gen(function*() {
    const before = state.workers.length
    expect(yield* createHistoryObserver({ enabled: false, configPath: "unused", createWorker: makeWorker, report: () => undefined })).toBeUndefined()
    expect(state.workers).toHaveLength(before)
  }))

  it.effect("bounds delayed-start intake at 128 events, sends one batch at a time, and terminates after close", () => Effect.gen(function*() {
    const problems: Array<string | undefined> = []
    let current: FixtureWorker | undefined
    yield* Effect.scoped(Effect.gen(function*() {
      const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", createWorker: makeWorker, report: (message) => { problems.push(message) } })

      if (observer === undefined) throw new Error("missing observer")
      yield* TestClock.adjust("1 millis")
      current = latestWorker()

      for (let index = 0; index < 140; index++) yield* observer.observe(observation(`synthetic-${index}`))
      expect(current.sent).toHaveLength(0)
      current.emit("message", { type: "ready" })
      yield* TestClock.adjust("250 millis")
      expect(current.sent).toHaveLength(1)
      expect(current.sent[0]).toMatchObject({ type: "batch", sequence: 1, events: Array.from({ length: 16 }, () => expect.anything()) })
      yield* TestClock.adjust("250 millis")
      expect(current.sent).toHaveLength(1)

      for (let sequence = 1; sequence <= 8; sequence++) {
        current.emit("message", { type: "ack", sequence })
        yield* TestClock.adjust("250 millis")
      }

      const records = current.sent.flatMap((message) => message.type === "batch" ? message.events : [])
      expect(records).toHaveLength(128)
      expect(records.at(-1)?.command).toBe("synthetic-127")
      expect(problems.some((message) => message?.includes("overflow"))).toBe(true)
    }))
    expect(current?.terminated).toBe(true)
    expect(current?.sent.at(-1)?.type).toBe("close")
  }))

  it.effect("bounds byte pressure and never truncates oversized events", () => Effect.scoped(Effect.gen(function*() {
    const problems: Array<string | undefined> = []
    const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", createWorker: makeWorker, report: (message) => { problems.push(message) } })

    if (observer === undefined) throw new Error("missing observer")
    yield* TestClock.adjust("1 millis")
    const current = latestWorker()

    for (let index = 0; index < 30; index++) yield* observer.observe(observation("x".repeat(60_000)))
    yield* observer.observe(observation("y".repeat(70_000)))
    current.emit("message", { type: "ready" })
    yield* TestClock.adjust("250 millis")
    const message = current.sent[0]
    expect(message?.type === "batch" ? message.events.length : 0).toBe(4)
    expect(problems.some((message) => message?.includes("overflow"))).toBe(true)
    expect(problems.some((message) => message?.includes("oversized"))).toBe(true)
    current.emit("error", new Error("synthetic-no-diagnostic-message"))
    yield* TestClock.adjust("250 millis")
    expect(current.terminated).toBe(true)
  })))

  it.effect.each(["crash", "sequence", "unknown", "startup-timeout", "lost-ack"] as const)("backs off after %s without review-triggered restarts", (kind) => Effect.scoped(Effect.gen(function*() {
    const problems: Array<string | undefined> = []
    const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", createWorker: makeWorker, report: (message) => { problems.push(message) } })

    if (observer === undefined) throw new Error("missing observer")
    yield* TestClock.adjust("1 millis")
    const current = latestWorker()
    const count = state.workers.length

    if (kind !== "startup-timeout") current.emit("message", { type: "ready" })

    if (kind === "lost-ack") {
      yield* observer.observe(observation())
      yield* TestClock.adjust("250 millis")
    }

    if (kind === "crash") current.emit("error", new Error("secret-stack-not-forwarded"))

    if (kind === "sequence") current.emit("message", { type: "ack", sequence: 999 })

    if (kind === "unknown") current.emit("message", { type: "unknown", message: "secret-not-forwarded" })
    yield* TestClock.adjust("6 seconds")
    expect(current.terminated).toBe(true)

    for (let index = 0; index < 32; index++) yield* observer.observe(observation())
    expect(state.workers).toHaveLength(count)
    expect(JSON.stringify(problems)).not.toContain("secret")
    yield* TestClock.adjust("30 seconds")
    expect(state.workers).toHaveLength(count + 1)
    latestWorker().emit("error", new Error("finish"))
    yield* TestClock.adjust("250 millis")
  })))

  it.effect("final drain stops after 500 ms even with an unacknowledged batch", () => Effect.gen(function*() {
    let current: FixtureWorker | undefined
    const ready = yield* Deferred.make<void>()

    const scoped = yield* Effect.scoped(Effect.gen(function*() {
      const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", createWorker: makeWorker, report: () => undefined })

      if (observer === undefined) throw new Error("missing observer")
      yield* Effect.yieldNow
      current = latestWorker()
      current.emit("message", { type: "ready" })
      yield* observer.observe(observation())
      yield* Deferred.succeed(ready, undefined)
    })).pipe(Effect.forkChild)

    yield* Deferred.await(ready)
    yield* TestClock.adjust("500 millis")
    yield* Fiber.join(scoped)
    expect(current?.terminated).toBe(true)
  }))
})

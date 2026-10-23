import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as TestClock from "effect/testing/TestClock"
import * as WorkerError from "effect/workers/WorkerError"
import type * as Worker from "effect/workers/Worker"
import type { HistoryObservation } from "../src/history.ts"
import { HistoryCommand, HistoryReply } from "../src/opencode/history-protocol.ts"
import { createHistoryObserver } from "../src/opencode/history.ts"
import { HistoryWorkers } from "../src/opencode/history-transport.ts"

const observation = (command = "synthetic"): HistoryObservation => ({ command, result: "explicit-ask", provider: "custom", tsMs: 0, latencyMs: null })

const fixture = Effect.gen(function*() {
  const opened = yield* Queue.dropping<{
    readonly ready: Deferred.Deferred<void>
    readonly replies: Queue.Queue<unknown, WorkerError.WorkerError>
    readonly sent: Queue.Queue<HistoryCommand>
    readonly disposed: Ref.Ref<boolean>
    readonly sendFailure: Ref.Ref<boolean>
  }>(4)

  const constructorFailure = yield* Ref.make(false)

  const service = HistoryWorkers.of({
    open: () => Effect.gen(function*() {
      if (yield* Ref.get(constructorFailure)) return yield* new WorkerError.WorkerError({ reason: new WorkerError.WorkerSpawnError({ message: "synthetic" }) })
      const ready = yield* Deferred.make<void>()
      const replies = yield* Queue.dropping<unknown, WorkerError.WorkerError>(1)
      const sent = yield* Queue.dropping<HistoryCommand>(64)
      const disposed = yield* Ref.make(false)
      const sendFailure = yield* Ref.make(false)
      yield* Queue.offer(opened, { ready, replies, sent, disposed, sendFailure })

      const worker: Worker.Worker<unknown, HistoryCommand> = {
        send: (command) => Effect.gen(function*() {
          if (yield* Ref.get(sendFailure)) return yield* new WorkerError.WorkerError({ reason: new WorkerError.WorkerSendError({ message: "synthetic" }) })
          yield* Queue.offer(sent, command)

          if (HistoryCommand.guards.Close(command)) yield* Queue.offer(replies, HistoryReply.cases.Closed.make({ sequence: command.sequence }))
        }),
        run: (handler, options) => Effect.gen(function*() {
          yield* Deferred.await(ready)
          yield* options?.onSpawn ?? Effect.void

          return yield* Queue.take(replies).pipe(Effect.flatMap(handler), Effect.forever)
        }).pipe(Effect.ensuring(Ref.set(disposed, true))),
      }

      return worker
    }),
  })

  return { opened, constructorFailure, service }
})

describe.skipIf(process.platform === "win32")("bounded Effect history worker", () => {
  it.effect("OFF never acquires a worker", () => Effect.gen(function*() {
    const { service, opened } = yield* fixture
    expect(yield* createHistoryObserver({ enabled: false, configPath: "unused", report: () => undefined }).pipe(Effect.provideService(HistoryWorkers, service))).toBeUndefined()
    expect(yield* Queue.size(opened)).toBe(0)
  }))

  it.effect("bounds delayed intake, sends one batch at a time, drops newest and retains the diagnostic", () => Effect.gen(function*() {
    const { service, opened } = yield* fixture
    const problems: Array<string | undefined> = []
    const done = yield* Deferred.make<void>()

    const test = yield* Effect.scoped(Effect.gen(function*() {
      const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", report: (message) => { problems.push(message) } }).pipe(Effect.provideService(HistoryWorkers, service))

      if (observer === undefined) throw new Error("missing observer")
      const current = yield* Queue.take(opened)

      for (let index = 0; index < 140; index++) yield* observer.observe(observation(`synthetic-${index}`))
      expect(yield* Queue.size(current.sent)).toBe(0)
      yield* Deferred.succeed(current.ready, undefined)
      const records: string[] = []

      for (let sequence = 1; sequence <= 8; sequence++) {
        const command = yield* Queue.take(current.sent)
        expect(command.sequence).toBe(sequence)

        if (!HistoryCommand.guards.Append(command)) throw new Error("expected append")
        records.push(...command.events.map((event) => event.command))
        expect(yield* Queue.size(current.sent)).toBe(0)
        yield* Queue.offer(current.replies, HistoryReply.cases.Stored.make({ sequence }))
      }

      expect(records).toHaveLength(128)
      expect(records.at(-1)).toBe("synthetic-127")
      expect(problems.at(-1)).toContain("overflow")
      yield* Deferred.succeed(done, undefined)

      return current
    })).pipe(Effect.forkChild)

    yield* Deferred.await(done)
    yield* TestClock.adjust("500 millis")
    const current = yield* Fiber.join(test)
    expect(yield* Ref.get(current.disposed)).toBe(true)
    expect(HistoryCommand.guards.Close(yield* Queue.take(current.sent))).toBe(true)
  }))

  it.effect("bounds byte pressure and drops oversized events whole", () => Effect.gen(function*() {
    const { service, opened } = yield* fixture
    const problems: Array<string | undefined> = []
    const done = yield* Deferred.make<void>()

    const test = yield* Effect.scoped(Effect.gen(function*() {
      const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", report: (message) => { problems.push(message) } }).pipe(Effect.provideService(HistoryWorkers, service))

      if (observer === undefined) throw new Error("missing observer")
      const current = yield* Queue.take(opened)

      for (let index = 0; index < 30; index++) yield* observer.observe(observation("x".repeat(60_000)))
      yield* observer.observe(observation("y".repeat(70_000)))
      yield* Deferred.succeed(current.ready, undefined)
      const command = yield* Queue.take(current.sent)
      expect(HistoryCommand.guards.Append(command) ? command.events.length : 0).toBe(4)
      expect(problems.some((message) => message?.includes("overflow"))).toBe(true)
      expect(problems.some((message) => message?.includes("oversized"))).toBe(true)
      yield* Deferred.succeed(done, undefined)

      return current
    })).pipe(Effect.forkChild)

    yield* Deferred.await(done)
    yield* TestClock.adjust("500 millis")
    expect(yield* Ref.get((yield* Fiber.join(test)).disposed)).toBe(true)
  }))

  it.effect.each(["crash", "sequence", "request", "failed-ack", "unknown", "startup-timeout", "lost-ack", "send", "receive"] as const)("backs off after %s and disposes every scope", (kind) => Effect.gen(function*() {
    const { service, opened } = yield* fixture
    const problems: Array<string | undefined> = []
    const done = yield* Deferred.make<void>()

    const test = yield* Effect.scoped(Effect.gen(function*() {
      const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", report: (message) => { problems.push(message) } }).pipe(Effect.provideService(HistoryWorkers, service))

      if (observer === undefined) throw new Error("missing observer")
      const current = yield* Queue.take(opened)

      if (kind !== "startup-timeout") yield* Deferred.succeed(current.ready, undefined)

      if (kind === "send") yield* Ref.set(current.sendFailure, true)
      yield* observer.observe(observation())
      yield* TestClock.adjust("250 millis")

      if (kind === "crash" || kind === "receive") yield* Queue.fail(current.replies, new WorkerError.WorkerError({ reason: new WorkerError.WorkerReceiveError({ message: "secret-never-forwarded" }) }))

      if (kind === "sequence") yield* Queue.offer(current.replies, HistoryReply.cases.Stored.make({ sequence: 999 }))

      if (kind === "request") yield* Queue.offer(current.replies, HistoryReply.cases.Closed.make({ sequence: 1 }))

      if (kind === "failed-ack") yield* Queue.offer(current.replies, HistoryReply.cases.Failed.make({ kind: "busy" }))

      if (kind === "unknown") yield* Queue.offer(current.replies, { invalid: "secret-never-forwarded" })
      yield* TestClock.adjust("6 seconds")
      expect(yield* Ref.get(current.disposed)).toBe(true)

      for (let index = 0; index < 32; index++) yield* observer.observe(observation())
      expect(yield* Queue.size(opened)).toBe(0)
      expect(JSON.stringify(problems)).not.toContain("secret")

      if (kind === "failed-ack") expect(problems.at(-1)).toContain("busy")
      yield* TestClock.adjust("30 seconds")
      const next = yield* Queue.take(opened)
      yield* Queue.fail(next.replies, new WorkerError.WorkerError({ reason: new WorkerError.WorkerReceiveError({ message: "finish" }) }))
      yield* Deferred.succeed(done, undefined)
    })).pipe(Effect.forkChild)

    yield* Deferred.await(done)
    yield* TestClock.adjust("500 millis")
    yield* Fiber.join(test)
  }))

  it.effect("constructor failure is typed and retries only after thirty seconds", () => Effect.gen(function*() {
    const { service, opened, constructorFailure } = yield* fixture
    yield* Ref.set(constructorFailure, true)
    const problems: string[] = []
    const done = yield* Deferred.make<void>()

    const test = yield* Effect.scoped(Effect.gen(function*() {
      yield* createHistoryObserver({ enabled: true, configPath: "unused", report: (message) => { if (message) problems.push(message) } }).pipe(Effect.provideService(HistoryWorkers, service))
      yield* TestClock.adjust("1 millis")
      expect(problems.at(-1)).toContain("worker")
      yield* Ref.set(constructorFailure, false)
      yield* TestClock.adjust("29 seconds")
      expect(yield* Queue.size(opened)).toBe(0)
      yield* TestClock.adjust("1 second")
      expect(yield* Queue.size(opened)).toBe(1)
      yield* Deferred.succeed(done, undefined)
    })).pipe(Effect.forkChild)

    yield* Deferred.await(done)
    yield* TestClock.adjust("500 millis")
    yield* Fiber.join(test)
  }))

  it.effect("drains for at most 500 ms when the worker loses an acknowledgement", () => Effect.gen(function*() {
    const { service, opened } = yield* fixture
    const draining = yield* Deferred.make<void>()
    const disposed = yield* Deferred.make<Ref.Ref<boolean>>()

    const test = yield* Effect.scoped(Effect.gen(function*() {
      const observer = yield* createHistoryObserver({ enabled: true, configPath: "unused", report: () => undefined }).pipe(Effect.provideService(HistoryWorkers, service))

      if (observer === undefined) throw new Error("missing observer")
      const current = yield* Queue.take(opened)
      yield* Deferred.succeed(disposed, current.disposed)
      yield* Deferred.succeed(current.ready, undefined)
      yield* observer.observe(observation())
      yield* Queue.take(current.sent)
      yield* Deferred.succeed(draining, undefined)
    })).pipe(Effect.forkChild)

    yield* Deferred.await(draining)
    yield* TestClock.adjust("499 millis")
    const state = yield* Deferred.await(disposed)
    expect(yield* Ref.get(state)).toBe(false)
    yield* TestClock.adjust("1 millis")
    yield* Fiber.join(test)
    expect(yield* Ref.get(state)).toBe(true)
  }))
})

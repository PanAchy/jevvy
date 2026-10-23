import { expect, it } from "@effect/vitest"
import { Worker } from "node:worker_threads"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import { HistoryTerminationError, HistoryWorkers, makeHistoryWorkersLayer, terminateHistoryWorker } from "../src/opencode/history-transport.ts"
import { HistoryCommand } from "../src/opencode/history-protocol.ts"

class RejectingTerminationWorker extends Worker {
  override terminate() {
    return super.terminate().then(() => { throw new Error("synthetic termination rejection") })
  }
}

it.effect("termination rejection stays a named typed failure rather than a defect", () => Effect.gen(function*() {
  const result = yield* terminateHistoryWorker({ terminate: () => Promise.reject(new Error("synthetic")) }).pipe(Effect.result)
  expect(Result.isFailure(result) && result.failure instanceof HistoryTerminationError).toBe(true)
}))

it.live.each(["scope-close", "worker-failure"] as const)("recovers rejected native termination during %s without failing the owning scope", (kind) => Effect.gen(function*() {
  const terminationFailures = yield* Ref.make(0)
  const started = yield* Deferred.make<void>()
  const layer = makeHistoryWorkersLayer(() => new RejectingTerminationWorker(`const { parentPort } = require('node:worker_threads'); parentPort.postMessage([0]); parentPort.on('message', () => { throw new Error('synthetic crash') });`, { eval: true }))
  yield* Effect.scoped(Effect.gen(function*() {
    const worker = yield* (yield* HistoryWorkers).open("unused", Ref.update(terminationFailures, (count) => count + 1))
    const run = yield* worker.run(() => Effect.void, { onSpawn: Deferred.succeed(started, undefined).pipe(Effect.asVoid) }).pipe(Effect.forkScoped)
    yield* Deferred.await(started)

    if (kind === "worker-failure") {
      yield* worker.send(HistoryCommand.cases.Close.make({ sequence: 1 }))
      expect(Result.isFailure(yield* Fiber.join(run).pipe(Effect.result))).toBe(true)
    }
  })).pipe(Effect.provide(layer))
  expect(yield* Ref.get(terminationFailures)).toBe(1)
}))

it.effect("native constructor exceptions enter the worker typed failure channel", () => Effect.gen(function*() {
  const layer = makeHistoryWorkersLayer(() => { throw new Error("synthetic constructor") })

  const result = yield* Effect.scoped(Effect.gen(function*() {
    const worker = yield* (yield* HistoryWorkers).open("unused", Effect.void)

    return yield* worker.run(() => Effect.void)
  })).pipe(Effect.provide(layer), Effect.result)

  expect(Result.isFailure(result) && result.failure.reason._tag).toBe("WorkerSpawnError")
}))

it.live.each(["malformed", "message-error"] as const)("native %s input fails truthfully without throwing from a callback", (kind) => Effect.gen(function*() {
  const source = kind === "malformed" ? `parentPort.postMessage({ invalid: 'synthetic' })` : `parentPort.postMessage([0])`
  let native: Worker | undefined

  const layer = makeHistoryWorkersLayer(() => {
    const worker = new Worker(`const { parentPort } = require('node:worker_threads'); ${source}; parentPort.on('message', () => {});`, { eval: true })
    native = worker

    return worker
  })

  const result = yield* Effect.scoped(Effect.gen(function*() {
    const worker = yield* (yield* HistoryWorkers).open("unused", Effect.void)

    return yield* worker.run(() => Effect.void, { onSpawn: Effect.sync(() => { native?.emit("messageerror", new Error("synthetic")) }) })
  })).pipe(Effect.provide(layer), Effect.result, Effect.timeout("5 seconds"))

  expect(Result.isFailure(result)).toBe(true)
}))

import { Worker as NativeWorker } from "node:worker_threads"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Worker from "effect/workers/Worker"
import * as WorkerError from "effect/workers/WorkerError"
import type { HistoryCommand } from "./history-protocol.ts"

export class HistoryTerminationError extends Schema.TaggedError<HistoryTerminationError>()("HistoryTerminationError", {}) {}

export const terminateHistoryWorker = Effect.fn("ReviewHistory.terminateWorker")((worker: Pick<NativeWorker, "terminate">) => Effect.tryPromise({
  try: () => worker.terminate(),
  catch: () => new HistoryTerminationError(),
}))

export class HistoryWorkers extends Context.Service<HistoryWorkers, {
  readonly open: (configPath: string, terminationFailed: Effect.Effect<void>) => Effect.Effect<Worker.Worker<unknown, HistoryCommand>, WorkerError.WorkerError>
}>()("jevvy/HistoryWorkers") {}

const PlatformFrame = Schema.Union([
  Schema.Tuple([Schema.Literal(0)]),
  Schema.Tuple([Schema.Literal(1), Schema.Unknown]),
])

export const makeHistoryWorkersLayer = (spawn: (configPath: string) => NativeWorker) => Layer.succeed(HistoryWorkers, HistoryWorkers.of({
  open: Effect.fn("ReviewHistory.openWorker")(function*(configPath, terminationFailed) {
    const platform = Worker.makePlatform<string>()({
      setup: ({ worker: path, scope }) => Effect.gen(function*() {
        const worker = yield* Effect.try({
          try: () => spawn(path),
          catch: (cause) => new WorkerError.WorkerError({ reason: new WorkerError.WorkerSpawnError({ message: "History worker could not start", cause }) }),
        })

        yield* Scope.addFinalizer(scope, terminateHistoryWorker(worker).pipe(
          Effect.catchTag("HistoryTerminationError", () => Effect.sync(() => worker.unref()).pipe(Effect.andThen(terminationFailed))),
          Effect.asVoid,
        ))

        return worker
      }),
      listen: ({ port, emit, deferred }) => Effect.sync(() => {
        const fail = () => Deferred.doneUnsafe(deferred, Exit.fail(new WorkerError.WorkerError({ reason: new WorkerError.WorkerReceiveError({ message: "History worker transport failed" }) })))

        const message = (cause: unknown) => {
          const decoded = Schema.decodeUnknownResult(PlatformFrame, { onExcessProperty: "error" })(cause)

          if (Result.isFailure(decoded)) {
            fail()

            return
          }

          emit(decoded.success)
        }

        const exit = () => {
          fail()
          port.off("message", message)
          port.off("messageerror", fail)
          port.off("error", fail)
        }

        port.on("message", message)
        port.on("messageerror", fail)
        port.on("error", fail)
        port.once("exit", exit)
      }),
    })

    return yield* platform.spawn<unknown, HistoryCommand>(0).pipe(Effect.provideService(Worker.Spawner, () => configPath))
  }),
}))

export const historyWorkersLayer = makeHistoryWorkersLayer((configPath) => new NativeWorker(new URL("./history-worker.js", import.meta.url), { workerData: { configPath } }))

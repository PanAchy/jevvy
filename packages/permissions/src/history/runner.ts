import { parentPort, workerData } from "node:worker_threads"
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as Layer from "effect/Layer"
import type * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as WorkerRunner from "effect/workers/WorkerRunner"
import { HistoryStorageError } from "../history.ts"
import { HistoryCommand, HistoryReply } from "./history-protocol.ts"
import { prepareHistoryStore, verifyHistoryPath } from "./history-files.ts"
import { appendHistory, initializeHistory } from "./history-store.ts"

const retryBusy = { times: 2, schedule: Schedule.spaced("25 millis"), while: (error: HistoryStorageError) => error.kind === "busy" }

const program = Effect.fn("ReviewHistory.worker")(function*(sqlite: (filename: string) => Layer.Layer<SqlClient.SqlClient, SqlError.SqlError | HistoryStorageError>) {
  const runner = yield* (yield* WorkerRunner.WorkerRunnerPlatform).start<HistoryReply, unknown>()
  const commands = yield* Queue.dropping<HistoryCommand, HistoryStorageError>(1)
  const failed = yield* Deferred.make<never, HistoryStorageError>()

  const receive = Effect.fn("ReviewHistory.receive")(function*(command: HistoryCommand) {
    if (!(yield* Queue.offer(commands, command))) return yield* new HistoryStorageError({ kind: "worker" })
  })

  const work = Effect.gen(function*() {
    const sequence = yield* Effect.scoped(Effect.gen(function*() {
      const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ configPath: Schema.String }), { onExcessProperty: "error" })(workerData).pipe(Effect.mapError(() => new HistoryStorageError({ kind: "worker" })))
      const path = yield* prepareHistoryStore(input.configPath).pipe(Effect.retry(retryBusy))

      return yield* Effect.gen(function*() {
        yield* initializeHistory().pipe(Effect.andThen(verifyHistoryPath(path)), Effect.retry(retryBusy))

        const receiver = yield* runner.run((_port, raw) => Schema.decodeUnknownEffect(HistoryCommand, { onExcessProperty: "error" })(raw).pipe(
          Effect.mapError(() => new HistoryStorageError({ kind: "worker" })),
          Effect.flatMap(receive),
          Effect.catch((error) => Deferred.fail(failed, error)),
        )).pipe(
          Effect.andThen(Effect.fail(new HistoryStorageError({ kind: "worker" }))),
          Effect.mapError(() => new HistoryStorageError({ kind: "worker" })),
          Effect.forkScoped,
        )

        const sequence = yield* Ref.make(1)

        const processCommand = Effect.fn("ReviewHistory.processCommand")(function*() {
          const command = yield* Queue.take(commands)
          const current = yield* Ref.get(sequence)

          if (command.sequence !== current) return yield* new HistoryStorageError({ kind: "worker" })

          if (HistoryCommand.guards.Close(command)) return false
          yield* verifyHistoryPath(path).pipe(Effect.retry(retryBusy))
          yield* appendHistory(command.events)
          yield* verifyHistoryPath(path).pipe(Effect.retry(retryBusy))
          yield* runner.send(0, HistoryReply.cases.Stored.make({ sequence: current }))
          yield* Ref.update(sequence, (value) => value + 1)

          return true
        })

        yield* Effect.raceFirst(processCommand().pipe(Effect.repeat({ while: (more) => more })), Effect.raceFirst(Deferred.await(failed), Fiber.join(receiver)))

        return yield* Ref.get(sequence)
      }).pipe(Effect.provide(sqlite(path.filename)), Effect.mapError((error) => error instanceof HistoryStorageError ? error : new HistoryStorageError({ kind: "storage" })))
    }))

    yield* runner.send(0, HistoryReply.cases.Closed.make({ sequence }))
  })

  yield* work.pipe(
    Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), (cause) => {
      const error = Cause.findError(cause)

      return runner.send(0, HistoryReply.cases.Failed.make({ kind: Result.isSuccess(error) && error.success instanceof HistoryStorageError ? error.success.kind : "worker" }))
    }),
  )
})

export const runHistoryWorker = (sqlite: (filename: string) => Layer.Layer<SqlClient.SqlClient, SqlError.SqlError | HistoryStorageError>) => Effect.runFork(Effect.scoped(program(sqlite)).pipe(
  Effect.provide(NodeWorkerRunner.layer),
  Effect.ensuring(Effect.sync(() => parentPort?.close())),
))

import { parentPort, workerData } from "node:worker_threads"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import { HistoryRequest, HistoryStorageError } from "../history.ts"
import type { HistoryResponse } from "../history.ts"
import { prepareHistoryStore, verifyHistoryPath } from "./history-files.ts"
import { appendHistory, initializeHistory } from "./history-store.ts"

const port = parentPort

if (port === null) throw new HistoryStorageError({ kind: "worker" })

const send = (message: Schema.Schema.Type<typeof HistoryResponse>) => port.postMessage(message)

const start = async () => {
  const input = Schema.decodeUnknownSync(Schema.Struct({ configPath: Schema.String }), { onExcessProperty: "error" })(workerData)

  const prepared = await Effect.runPromise(prepareHistoryStore(input.configPath).pipe(
    Effect.retry({ times: 2, schedule: Schedule.spaced("25 millis"), while: (error) => error.kind === "busy" }),
    Effect.match({ onFailure: (error) => ({ error }), onSuccess: (path) => ({ path }) }),
  ))

  if ("error" in prepared) {
    send({ type: "problem", kind: prepared.error.kind })
    port.close()

    return
  }

  const path = prepared.path

  const adapter = process.versions.bun
    ? await import("@effect/sql-sqlite-bun/SqliteClient")
    : await import("@effect/sql-sqlite-node/SqliteClient")

  const runtime = ManagedRuntime.make(adapter.layer({ filename: path.filename, disableWAL: true, busyTimeout: 25 }))
  let sequence = 0
  let processing = false

  try {
    const problem = await runtime.runPromise(initializeHistory().pipe(
      Effect.andThen(verifyHistoryPath(path)),
      Effect.retry({ times: 2, schedule: Schedule.spaced("25 millis"), while: (error) => error.kind === "busy" }),
      Effect.match({ onFailure: (error) => error.kind, onSuccess: () => undefined }),
    ))

    if (problem !== undefined) {
      await runtime.dispose()
      send({ type: "problem", kind: problem })
      port.close()

      return
    }

    send({ type: "ready" })
  } catch {
    await runtime.dispose()
    send({ type: "problem", kind: "storage" })
    port.close()

    return
  }

  port.on("message", async (raw) => {
    const decoded = Schema.decodeUnknownOption(HistoryRequest, { onExcessProperty: "error" })(raw)

    if (processing || Option.isNone(decoded) || decoded.value.sequence !== sequence + 1) {
      send({ type: "problem", kind: "worker" })

      return
    }

    const message = decoded.value
    sequence = message.sequence
    processing = true

    try {
      if (message.type === "close") {
        await runtime.dispose()
        send({ type: "closed" })
        port.close()

        return
      }

      const result = await runtime.runPromise(Effect.gen(function*() {
        yield* verifyHistoryPath(path)
        yield* appendHistory(message.events)
        yield* verifyHistoryPath(path)
      }).pipe(Effect.match({
        onFailure: (error) => ({ type: "problem" as const, kind: error.kind }),
        onSuccess: () => ({ type: "ack" as const, sequence }),
      })))

      send(result)
    } catch {
      send({ type: "problem", kind: "worker" })
    } finally {
      processing = false
    }
  })
}

start().catch(() => { send({ type: "problem", kind: "storage" }); port.close() })

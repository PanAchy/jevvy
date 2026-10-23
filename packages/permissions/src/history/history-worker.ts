import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { HistoryStorageError } from "../history.ts"
import { runHistoryWorker } from "./runner.ts"

runHistoryWorker((filename) => Layer.unwrap(Effect.tryPromise({
  try: async () => process.versions.bun ? await import("@effect/sql-sqlite-bun/SqliteClient") : await import("@effect/sql-sqlite-node/SqliteClient"),
  catch: () => new HistoryStorageError({ kind: "storage" }),
}).pipe(Effect.map((adapter) => adapter.layer({ filename, disableWAL: true, busyTimeout: 25 })))))

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { runHistoryWorker } from "../history/runner.ts"

runHistoryWorker((filename) => SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 25 }))

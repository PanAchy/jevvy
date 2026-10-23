import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"
import { HISTORY_BATCH_BYTES, HISTORY_BATCH_ROWS, HISTORY_EVENT_BYTES, HISTORY_LOGICAL_BYTES, HISTORY_ROWS, HistoryEvent, HistoryStorageError, eventBytes } from "../history.ts"

export const historySchema = {
  table: "CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL, ts TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','ask')), reason TEXT NOT NULL CHECK(reason IN ('judged','unavailable','empty','explicit-ask')), command TEXT NOT NULL, model TEXT, latency_ms REAL CHECK(latency_ms IS NULL OR latency_ms >= 0), detail_json TEXT NOT NULL CHECK(json_valid(detail_json)), event_bytes INTEGER NOT NULL CHECK(event_bytes BETWEEN 1 AND 65536))",
  index: "CREATE INDEX events_ts ON events(ts, id)",
}

const sqliteCode = (error: SqlError.SqlError): number => {
  const parsed = Schema.decodeUnknownOption(Schema.Struct({ errno: Schema.Int }))(error.reason.cause)

  return Option.isSome(parsed) ? parsed.value.errno & 255 : 0
}

const classify = (error: SqlError.SqlError): HistoryStorageError =>
  new HistoryStorageError({ kind: [5, 6].includes(sqliteCode(error)) ? "busy" : "storage" })

const pruneCapacity = Effect.fn("ReviewHistory.pruneCapacity")(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM events WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ts DESC, id DESC) AS position,
        SUM(event_bytes) OVER (ORDER BY ts DESC, id DESC ROWS UNBOUNDED PRECEDING) AS bytes
      FROM events
    ) WHERE position > ${HISTORY_ROWS} OR bytes > ${HISTORY_LOGICAL_BYTES}
  )`
})

export const initializeHistory = Effect.fn("ReviewHistory.initialize")(function*() {
  const sql = yield* SqlClient.SqlClient
  const mode = yield* sql.unsafe<{ journal_mode: string }>("PRAGMA journal_mode")

  if (mode[0]?.journal_mode !== "delete") return yield* new HistoryStorageError({ kind: "unsupported-schema" })
  yield* sql.unsafe("PRAGMA page_size=4096")
  yield* sql.unsafe("PRAGMA synchronous=FULL")
  yield* sql.unsafe("PRAGMA secure_delete=ON")
  yield* sql.unsafe("PRAGMA temp_store=MEMORY")
  yield* sql.unsafe("PRAGMA journal_size_limit=0")
  yield* sql.unsafe("PRAGMA trusted_schema=OFF")
  yield* sql.unsafe("PRAGMA max_page_count=8192")
  const settings = { page_size: 4096, max_page_count: 8192, synchronous: 2, secure_delete: 1, temp_store: 2, journal_size_limit: 0, trusted_schema: 0, busy_timeout: 25 }

  for (const [pragma, expected] of Object.entries(settings)) {
    const raw = yield* sql.unsafe(`PRAGMA ${pragma}`)
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Schema.Finite)).check(Schema.isMinLength(1), Schema.isMaxLength(1)))(raw).pipe(Effect.mapError(() => new HistoryStorageError({ kind: "unsupported-schema" })))

    if (rows[0]?.[pragma === "busy_timeout" ? "timeout" : pragma] !== expected) return yield* new HistoryStorageError({ kind: "unsupported-schema" })
  }

  yield* sql.withTransaction(Effect.gen(function*() {
    const application = yield* sql.unsafe<{ application_id: number }>("PRAGMA application_id")
    const version = yield* sql.unsafe<{ user_version: number }>("PRAGMA user_version")
    const definitions = yield* sql<{ name: string; sql: string | null }>`SELECT name, sql FROM sqlite_schema ORDER BY name`

    if (definitions.length === 0 && application[0]?.application_id === 0 && version[0]?.user_version === 0) {
      yield* sql.unsafe(historySchema.table)
      yield* sql.unsafe(historySchema.index)
      yield* sql.unsafe("PRAGMA application_id=1246058070")
      yield* sql.unsafe("PRAGMA user_version=1")
    } else if (application[0]?.application_id !== 1246058070 || version[0]?.user_version !== 1 || definitions.length !== 3 ||
      definitions[0]?.name !== "events" || definitions[0]?.sql !== historySchema.table ||
      definitions[1]?.name !== "events_ts" || definitions[1]?.sql !== historySchema.index ||
      definitions[2]?.name !== "sqlite_autoindex_events_1" || definitions[2]?.sql !== null) {
      return yield* new HistoryStorageError({ kind: "unsupported-schema" })
    }

    const integrity = yield* sql.unsafe<{ quick_check: string }>("PRAGMA quick_check(1)")

    if (integrity[0]?.quick_check !== "ok") return yield* new HistoryStorageError({ kind: "storage" })
    yield* pruneCapacity()
  }))
}, Effect.mapError((error) => error instanceof HistoryStorageError ? error : classify(error)))

export const appendHistory = Effect.fn("ReviewHistory.append")(function*(events: readonly HistoryEvent[]) {
  if (events.length === 0 || events.length > HISTORY_BATCH_ROWS) return yield* new HistoryStorageError({ kind: "worker" })

  const sql = yield* SqlClient.SqlClient
  let bytes = 0

  for (const event of events) {
    yield* Schema.decodeUnknownEffect(HistoryEvent, { onExcessProperty: "error" })(event).pipe(Effect.mapError(() => new HistoryStorageError({ kind: "storage" })))
    const size = eventBytes(event)
    bytes += size

    if (size > HISTORY_EVENT_BYTES || bytes > HISTORY_BATCH_BYTES) return yield* new HistoryStorageError({ kind: "oversized" })
  }

  const write = sql.withTransaction(Effect.gen(function*() {
    for (const event of events) {
      yield* sql`INSERT OR IGNORE INTO events (id, ts, effect, reason, command, model, latency_ms, detail_json, event_bytes)
        VALUES (${event.id}, ${event.ts}, ${event.effect}, ${event.reason}, ${event.command}, ${event.model}, ${event.latencyMs}, ${JSON.stringify(event.detail)}, ${eventBytes(event)})`
    }

    yield* pruneCapacity()
  }))

  yield* write.pipe(Effect.retry({ times: 2, schedule: Schedule.spaced("25 millis"), while: (error) => [5, 6].includes(sqliteCode(error)) }), Effect.catchTag("SqlError", (error) => {
    if (sqliteCode(error) !== 13) return Effect.fail(classify(error))

    return Effect.gen(function*() {
      yield* sql.withTransaction(sql`DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY ts, id LIMIT 256)`)
      yield* write
    }).pipe(Effect.mapError(classify))
  }))
})

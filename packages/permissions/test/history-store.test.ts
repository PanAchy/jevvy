import { describe, expect, it } from "@effect/vitest"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Match from "effect/Match"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import type * as SqlConnection from "effect/sql/SqlConnection"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { HISTORY_LOGICAL_BYTES, HISTORY_ROWS, HistoryEvent, decodeHistoryRow, projectHistory } from "../src/history.ts"
import { createHistoryMetadata } from "../src/history/metadata.ts"
import { createHistoryFiles, prepareHistoryStore, verifyHistoryPath } from "../src/history/history-files.ts"
import { HistoryNativeError, historyNative } from "../src/history/history-native.ts"
import { appendHistory, initializeHistory } from "../src/history/history-store.ts"
import type { VerifiedHistoryPath } from "../src/history/history-files.ts"

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "jevvy-history-test-"))
    await chmod(root, 0o700)

    return root
  }),
  use,
  (root) => Effect.promise(() => rm(root, { recursive: true })),
)

const event = (index = 0, size = 0): HistoryEvent => {
  const projected = projectHistory({ command: `synthetic-${index}-${"x".repeat(size)}`, result: "explicit-ask", provider: "custom", tsMs: index, latencyMs: null }, randomUUID())

  if (projected === undefined) throw new Error("invalid test event")

  return projected
}

const withStore = <A, E>(path: VerifiedHistoryPath, use: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  use.pipe(Effect.provide(SqliteClient.layer({ filename: path.filename, disableWAL: true, busyTimeout: 25 })))

const withSql = <A, E, R>(execute: SqlConnection.Connection["execute"], use: Effect.Effect<A, E, R | SqlClient.SqlClient>) => Effect.gen(function*() {
  const connection: SqlConnection.Connection = {
    execute, executeRaw: (query, params) => execute(query, params, undefined), executeUnprepared: execute,
    executeStream: () => Stream.die("unexpected stream"),
    executeValues: () => Effect.die("unexpected values"),
    executeValuesUnprepared: () => Effect.die("unexpected values"),
  }

  const sql = yield* SqlClient.make({ acquirer: Effect.succeed(connection), compiler: Statement.makeCompilerSqlite(), spanAttributes: [] })

  return yield* use.pipe(Effect.provideService(SqlClient.SqlClient, sql))
}).pipe(Effect.provide(Reactivity.layer))

describe("history SQL boundary faults", () => {
  it.effect.each([
    { rows: 0, bytes: 0 },
    { rows: HISTORY_ROWS, bytes: 1 },
    { rows: 1, bytes: HISTORY_LOGICAL_BYTES },
    { rows: HISTORY_ROWS, bytes: HISTORY_LOGICAL_BYTES },
    { rows: HISTORY_ROWS + 1, bytes: 1 },
    { rows: 1, bytes: HISTORY_LOGICAL_BYTES + 1 },
  ])("defers the capacity window only within both aggregate bounds: %j", (totals) => Effect.gen(function*() {
    const queries: string[] = []
    yield* withSql((query) => Effect.sync(() => {
      queries.push(query)

      return query.startsWith("SELECT COUNT") ? [totals] : []
    }), appendHistory([event()]))
    const aggregate = queries.findIndex((query) => query.startsWith("SELECT COUNT"))
    const window = queries.findIndex((query) => query.includes("ROW_NUMBER()"))
    expect(aggregate).toBeGreaterThan(queries.findIndex((query) => query.startsWith("INSERT")))
    expect(window > aggregate).toBe(totals.rows > HISTORY_ROWS || totals.bytes > HISTORY_LOGICAL_BYTES)
    expect(queries.at(-1)).toBe("COMMIT")
  }))

  it.effect.each([[], [{ rows: 0, bytes: 0 }, { rows: 0, bytes: 0 }], [{ rows: -1, bytes: 0 }], [{ rows: 0, bytes: -1 }], [{ rows: "0", bytes: 0 }], [{ rows: 0, bytes: null }]])("rejects malformed capacity aggregates before any eviction: %j", (totals) => Effect.gen(function*() {
    const queries: string[] = []

    const result = yield* withSql((query) => Effect.sync(() => {
      queries.push(query)

      return query.startsWith("SELECT COUNT") ? totals : []
    }), appendHistory([event()])).pipe(Effect.flip)

    expect(result).toMatchObject({ kind: "unsupported-schema" })
    expect(queries.some((query) => query.startsWith("DELETE"))).toBe(false)
    expect(queries.at(-1)).toBe("ROLLBACK")
  }))

  it.effect("performs only one physical capacity recovery for SQLITE_FULL", () => Effect.gen(function*() {
    const queries: string[] = []
    let attempts = 0

    const result = yield* withSql((query) => Effect.gen(function*() {
      queries.push(query)

      if (query.startsWith("INSERT")) {
        attempts++

        return yield* new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: { errno: 13 } }) })
      }

      return []
    }), appendHistory([event()])).pipe(Effect.flip)

    expect(result).toMatchObject({ kind: "storage" })
    expect(attempts).toBe(2)
    expect(queries.filter((query) => query.includes("LIMIT 256"))).toHaveLength(1)
  }))

  it.effect.each([true, false])("retries only typed lock timeouts without driver errno: %s", (busy) => Effect.gen(function*() {
    const times: number[] = []
    const error = new SqlError.SqlError({ reason: busy ? new SqlError.LockTimeoutError({ cause: undefined }) : new SqlError.UnknownError({ cause: undefined }) })

    const result = yield* withSql((query) => Effect.gen(function*() {
      if (query.startsWith("INSERT")) {
        times.push(yield* Clock.currentTimeMillis)

        return yield* error
      }

      return []
    }), appendHistory([event()])).pipe(Effect.flip, Effect.forkChild)

    yield* TestClock.adjust("24 millis")
    expect(times).toEqual([0])
    yield* TestClock.adjust("1 millis")
    expect(times).toEqual(busy ? [0, 25] : [0])
    yield* TestClock.adjust("25 millis")
    expect(yield* Fiber.join(result)).toMatchObject({ kind: busy ? "busy" : "storage" })
    expect(times).toEqual(busy ? [0, 25, 50] : [0])
  }))

  it.effect.each(["journal_mode", "application_id", "user_version", "quick_check(1)", "page_size", "definitions"])("rejects malformed, absent and duplicate %s rows before pruning", (boundary) => Effect.gen(function*() {
    const valid = new Map<string, string | number>([["journal_mode", "delete"], ["application_id", 0], ["user_version", 0], ["quick_check", "ok"], ["page_size", 4096]])
    const key = boundary === "quick_check(1)" ? "quick_check" : boundary
    const row = { [key]: valid.get(key) }

    const integrityFailure = [{ quick_check: "corrupt" }]

    for (const bad of [[], [{ wrong: true }], [row, row], ...(boundary === "quick_check(1)" ? [integrityFailure] : [])]) {
      const queries: string[] = []

      const result = yield* withSql((query) => Effect.sync(() => {
        queries.push(query)
        const pragma = query.replace("PRAGMA ", "")

        if (pragma === boundary || (boundary === "definitions" && query.startsWith("SELECT name"))) return bad
        const settings = new Map<string, string | number>([["journal_mode", "delete"], ["page_size", 4096], ["max_page_count", 8192], ["synchronous", 2], ["secure_delete", 1], ["temp_store", 2], ["journal_size_limit", 0], ["trusted_schema", 0], ["busy_timeout", 25], ["application_id", boundary === "definitions" ? 1246058070 : 0], ["user_version", 0], ["quick_check(1)", "ok"]])
        const key = Match.value(pragma).pipe(Match.when("busy_timeout", () => "timeout"), Match.when("quick_check(1)", () => "quick_check"), Match.orElse((value) => value))

        if (settings.has(pragma)) return [{ [key]: settings.get(pragma) }]

        return []
      }), initializeHistory()).pipe(Effect.flip)

      expect(result).toMatchObject({ kind: bad === integrityFailure ? "storage" : "unsupported-schema" })
      expect(queries.some((query) => query.startsWith("DELETE"))).toBe(false)
    }
  }))
})

describe.skipIf(process.platform === "win32")("private history SQL store", () => {
  it.effect("writes canonical metadata and verifies existing bytes without rewriting them", () => fixture((root) => Effect.gen(function*() {
    const config = join(root, "jevvy.jsonc")
    yield* prepareHistoryStore(config)
    const expected = createHistoryMetadata()

    for (const [name, content] of Object.entries(expected)) {
      const filename = join(root, "metrics", name)
      const before = yield* Effect.promise(() => lstat(filename))
      expect(yield* Effect.promise(() => readFile(filename, "utf8"))).toBe(content)
      yield* prepareHistoryStore(config)
      const after = yield* Effect.promise(() => lstat(filename))
      expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
    }
  })))

  it.effect.each([
    { rows: 10_000, bytes: 100 },
    { rows: 10_001, bytes: 100 },
    { rows: 256, bytes: 65_536 },
    { rows: 257, bytes: 65_536 },
    { rows: 300, bytes: 60_000 },
  ])("retains the original capacity-window survivor set at tied timestamps: %j", (population) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    yield* withStore(path, Effect.gen(function*() {
      yield* initializeHistory()
      const sql = yield* SqlClient.SqlClient
      yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ${population.rows})
        INSERT INTO events SELECT printf('%05d',x), '1970-01-01T00:00:00.000Z', 'ask', 'explicit-ask', 'synthetic', NULL, NULL, '{}', ${population.bytes} FROM n`

      const expected = yield* sql`SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ts DESC, id DESC) AS position,
          SUM(event_bytes) OVER (ORDER BY ts DESC, id DESC ROWS UNBOUNDED PRECEDING) AS bytes FROM events
      ) WHERE position <= ${HISTORY_ROWS} AND bytes <= ${HISTORY_LOGICAL_BYTES} ORDER BY id`

      yield* initializeHistory()
      expect(yield* sql`SELECT id FROM events ORDER BY id`).toEqual(expected)
    }))
  })))

  it.effect.each(["pathname", "descriptor"] as const)("rejects a foreign %s owner without metadata writes", (boundary) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    let writes = 0

    const foreign = (info: Stats) => {
      info.uid++

      return info
    }

    const files = createHistoryFiles({ ...historyNative,
      lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => boundary === "pathname" && name === path.filename ? foreign(info) : info)),
      open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => ({
        ...file,
        stat: boundary === "descriptor" ? file.stat.pipe(Effect.map(foreign)) : file.stat,
        writeText: () => Effect.sync(() => { writes++ }),
      }))),
    })

    expect(yield* files.prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.flip)).toMatchObject({ kind: "unsafe-path" })
    expect(writes).toBe(0)
  })))

  it.effect.each(["read", "close"] as const)("preserves typed %s failure and closes exactly once", (operation) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    let closes = 0
    let writes = 0

    const files = createHistoryFiles({ ...historyNative, open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => ({
      ...file,
      readText: new HistoryNativeError({ kind: "missing" }),
      writeText: () => Effect.sync(() => { writes++ }),
      close: Effect.gen(function*() {
        closes++
        yield* file.close

        if (operation === "close") return yield* new HistoryNativeError({ kind: "exists" })
      }),
    }))) })

    expect(yield* files.prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.flip)).toMatchObject({ kind: "storage" })
    expect(closes).toBe(operation === "close" ? 1 : 2)
    expect(writes).toBe(0)
    yield* verifyHistoryPath(path)
  })))

  it.effect.each(["file", "directory"] as const)("owns in-flight %s acquisition through interruption without later writes", (kind) => fixture((root) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    let closes = 0
    let writes = 0

    const files = createHistoryFiles({
      ...historyNative,
      open: (name, create) => historyNative.open(name, create).pipe(Effect.flatMap((file) => Effect.gen(function*() {
        yield* Deferred.succeed(entered, undefined)

        if (kind === "file") yield* Deferred.await(finish)

        return { ...file, writeText: () => Effect.sync(() => { writes++ }), close: file.close.pipe(Effect.tap(() => Effect.sync(() => { closes++ }))) }
      }))),
      opendir: (name) => historyNative.opendir(name).pipe(Effect.flatMap((directory) => Effect.gen(function*() {
        if (kind === "directory") {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(finish)
        }

        return { ...directory, close: directory.close.pipe(Effect.tap(() => Effect.sync(() => { closes++ }))) }
      }))),
    })

    const pending = yield* files.prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Effect.sync(() => pending.interruptUnsafe())
    yield* Deferred.succeed(finish, undefined)
    const result = yield* Fiber.await(pending)
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(closes).toBe(kind === "file" ? 2 : 1)
    expect(writes).toBe(0)
    expect(Exit.isFailure(yield* Effect.promise(() => readFile(join(root, "metrics", "AGENTS.md"), "utf8")).pipe(Effect.exit))).toBe(true)
  })))

  it.effect.each(["read", "close"] as const)("reports typed directory %s faults before file creation", (operation) => fixture((root) => Effect.gen(function*() {
    let closes = 0
    let opens = 0

    const files = createHistoryFiles({ ...historyNative,
      open: (name, create) => Effect.sync(() => { opens++ }).pipe(Effect.andThen(historyNative.open(name, create))),
      opendir: (name) => historyNative.opendir(name).pipe(Effect.map((directory) => ({
        read: operation === "read" ? new HistoryNativeError({ kind: "missing" }) : directory.read,
        close: Effect.gen(function*() {
          closes++
          yield* directory.close

          if (operation === "close") return yield* new HistoryNativeError({ kind: "exists" })
        }),
      }))),
    })

    expect(yield* files.prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.flip)).toMatchObject({ kind: "storage" })
    expect(closes).toBe(1)
    expect(opens).toBe(0)
  })))

  it.effect("interrupts an acquired metadata read and never writes later metadata", () => fixture((root) => Effect.gen(function*() {
    yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const entered = yield* Deferred.make<void>()
    let closes = 0
    let writes = 0

    const files = createHistoryFiles({ ...historyNative, open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => ({
      ...file,
      readText: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      writeText: () => Effect.sync(() => { writes++ }),
      close: file.close.pipe(Effect.tap(() => Effect.sync(() => { closes++ }))),
    }))) })

    const pending = yield* files.prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    const result = yield* Fiber.await(pending)
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(closes).toBe(2)
    expect(writes).toBe(0)
  })))

  it.effect.each(["missing", "linked", "unlinked"] as const)("classifies an initial zero-link journal snapshot as busy after one %s revalidation", (current) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    const header = Buffer.alloc(512)
    header.writeUInt32BE(512, 20)
    header.writeUInt32BE(4096, 24)
    yield* Effect.promise(() => writeFile(journal, header, { mode: 0o600 }))
    let snapshots = 0
    let parents = 0
    let opens = 0
    let reads = 0
    let closes = 0

    const files = createHistoryFiles({ ...historyNative,
      lstat: (name) => Effect.gen(function*() {
        if (name === join(root, "metrics")) parents++

        if (name === journal) {
          snapshots++

          if (snapshots === 2 && current === "missing") return yield* new HistoryNativeError({ kind: "missing" })
        }

        const info = yield* historyNative.lstat(name)

        return name === journal && (snapshots === 1 || snapshots === 2 && current === "unlinked") ? Object.assign(info, { nlink: 0 }) : info
      }),
      open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => {
        if (name !== journal) return file
        opens++

        return { ...file,
          read: (size) => Effect.sync(() => { reads++ }).pipe(Effect.andThen(file.read(size))),
          close: file.close.pipe(Effect.tap(() => Effect.sync(() => { closes++ }))),
        }
      })),
    })

    expect(yield* files.verifyHistoryPath(path).pipe(Effect.flip)).toMatchObject({ kind: "busy" })
    expect({ snapshots, parents, opens, reads, closes }).toEqual({ snapshots: 2, parents: 1, opens: 0, reads: 0, closes: 0 })
    yield* files.verifyHistoryPath(path)
    expect({ snapshots, opens, reads, closes }).toEqual({ snapshots: 3, opens: 1, reads: 1, closes: 1 })
  })))

  it.effect.each((["initial", "revalidation", "descriptor"] as const).flatMap((phase) =>
    (["owner", "mode", "hardlink", "symlink", "directory", "oversized"] as const).map((kind) => ({ phase, kind })),
  ))("rejects unsafe $kind journal metadata at the $phase snapshot without reading it", ({ phase, kind }) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    yield* Effect.promise(() => writeFile(journal, Buffer.alloc(512), { mode: 0o600 }))
    let snapshots = 0
    let opens = 0
    let reads = 0
    let closes = 0

    const unsafe = (info: Stats) => Object.assign(info, { nlink: 0 }, Match.value(kind).pipe(
      Match.when("owner", () => ({ uid: info.uid + 1 })),
      Match.when("mode", () => ({ mode: info.mode | 0o044 })),
      Match.when("hardlink", () => ({ nlink: 2 })),
      Match.when("symlink", () => ({ isFile: () => false, isSymbolicLink: () => true })),
      Match.when("directory", () => ({ isFile: () => false, isDirectory: () => true })),
      Match.when("oversized", () => ({ size: 40 * 1024 * 1024 + 1 })),
      Match.exhaustive,
    ))

    const files = createHistoryFiles({ ...historyNative,
      lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => {
        if (name !== journal) return info
        snapshots++

        if (phase === "initial" || phase === "revalidation" && snapshots === 2) return unsafe(info)

        return phase === "revalidation" ? Object.assign(info, { nlink: 0 }) : info
      })),
      open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => {
        if (name !== journal) return file
        opens++

        return { ...file,
          stat: file.stat.pipe(Effect.map((info) => phase === "descriptor" ? unsafe(info) : info)),
          read: (size) => Effect.sync(() => { reads++ }).pipe(Effect.andThen(file.read(size))),
          close: file.close.pipe(Effect.tap(() => Effect.sync(() => { closes++ }))),
        }
      })),
    })

    expect(yield* files.verifyHistoryPath(path).pipe(Effect.flip)).toMatchObject({ kind: "unsafe-path" })
    expect(snapshots).toBe(phase === "revalidation" ? 2 : 1)
    expect(opens).toBe(phase === "descriptor" ? 1 : 0)
    expect(closes).toBe(opens)
    expect(reads).toBe(0)
  })))

  it.effect.each(["prepare", "preflight"] as const)("uses bounded journal snapshots during %s directory inspection", (operation) => fixture((root) => Effect.gen(function*() {
    const config = join(root, "jevvy.jsonc")
    const path = yield* prepareHistoryStore(config)
    const journal = `${path.filename}-journal`
    yield* Effect.promise(() => writeFile(journal, Buffer.alloc(512), { mode: 0o600 }))
    let snapshots = 0
    let opens = 0

    const files = createHistoryFiles({ ...historyNative,
      lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => {
        if (name !== journal) return info
        snapshots++

        return Object.assign(info, { nlink: 0 })
      })),
      open: (name, create) => Effect.sync(() => { if (name === journal) opens++ }).pipe(Effect.andThen(historyNative.open(name, create))),
    })

    expect(yield* (operation === "prepare" ? files.prepareHistoryStore(config) : files.preflightHistoryStore(config)).pipe(Effect.flip)).toMatchObject({ kind: "busy" })
    expect(snapshots).toBe(2)
    expect(opens).toBe(0)
  })))

  it.effect("keeps zero-link main database snapshots unsafe", () => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    let snapshots = 0

    const files = createHistoryFiles({ ...historyNative, lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => {
      snapshots++

      return name === path.filename ? Object.assign(info, { nlink: 0 }) : info
    })) })

    expect(yield* files.verifyHistoryPath(path).pipe(Effect.flip)).toMatchObject({ kind: "unsafe-path" })
    expect(snapshots).toBe(1)
  })))

  it.effect("rejects an unsafe parent before resampling an initial zero-link journal", () => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    yield* Effect.promise(() => writeFile(journal, Buffer.alloc(512), { mode: 0o600 }))
    let snapshots = 0

    const files = createHistoryFiles({ ...historyNative, lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => {
      if (name === journal) {
        snapshots++

        return Object.assign(info, { nlink: 0 })
      }

      return name === join(root, "metrics") ? Object.assign(info, { mode: info.mode | 0o044 }) : info
    })) })

    expect(yield* files.verifyHistoryPath(path).pipe(Effect.flip)).toMatchObject({ kind: "unsafe-path" })
    expect(snapshots).toBe(1)
  })))

  it.effect.each((["unlinked", "replaced"] as const).flatMap((transition) =>
    [false, true].map((unlinkedRevalidation) => ({ transition, unlinkedRevalidation })),
  ))("classifies a $transition journal descriptor as busy before later success, zero-link revalidation=$unlinkedRevalidation", ({ transition, unlinkedRevalidation }) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    const header = Buffer.alloc(512)
    header.writeUInt32BE(512, 20)
    header.writeUInt32BE(4096, 24)
    yield* Effect.promise(() => writeFile(journal, header, { mode: 0o600 }))
    let inspections = 0
    let snapshots = 0
    let reads = 0
    let closes = 0

    const files = createHistoryFiles({ ...historyNative,
      lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => {
        if (name !== journal) return info
        snapshots++

        return snapshots === 2 && unlinkedRevalidation ? Object.assign(info, { nlink: 0 }) : info
      })),
      open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => name !== journal ? file : {
        ...file,
        stat: file.stat.pipe(Effect.map((info) => {
          inspections++

          return inspections === 1 ? Object.assign(info, transition === "unlinked" ? { nlink: 0 } : { ino: info.ino + 1 }) : info
        })),
        read: (size) => Effect.sync(() => { reads++ }).pipe(Effect.andThen(file.read(size))),
        close: file.close.pipe(Effect.tap(() => Effect.sync(() => { closes++ }))),
      })),
    })

    const result = yield* files.verifyHistoryPath(path).pipe(Effect.exit)
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ kind: "busy" })
    expect({ snapshots, inspections, reads, closes }).toEqual({ snapshots: 2, inspections: 1, reads: 0, closes: 1 })
    yield* files.verifyHistoryPath(path)
    expect({ snapshots, inspections, reads, closes }).toEqual({ snapshots: 3, inspections: 2, reads: 1, closes: 2 })
  })))

  it.effect.each(["parent", "replacement"] as const)("rejects unsafe journal %s while revalidating a transient unlink", (target) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    yield* Effect.promise(() => writeFile(journal, Buffer.alloc(512), { mode: 0o600 }))
    let opened = false

    const files = createHistoryFiles({ ...historyNative,
      lstat: (name) => historyNative.lstat(name).pipe(Effect.map((info) => opened && (target === "parent" ? name === join(root, "metrics") : name === journal)
        ? Object.assign(info, { mode: info.mode | 0o044 })
        : info)),
      open: (name, create) => historyNative.open(name, create).pipe(Effect.map((file) => name !== journal ? file : {
        ...file,
        stat: file.stat.pipe(Effect.map((info) => {
          opened = true

          return Object.assign(info, { nlink: 0 })
        })),
      })),
    })

    const result = yield* files.verifyHistoryPath(path).pipe(Effect.exit)
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ kind: "unsafe-path" })
  })))

  it.effect.each(["read", "close", "vanished"] as const)("distinguishes journal %s errors from an absent acquisition", (operation) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    const header = Buffer.alloc(512)
    header.writeUInt32BE(512, 20)
    header.writeUInt32BE(4096, 24)
    yield* Effect.promise(() => writeFile(journal, header, { mode: 0o600 }))
    let closes = 0

    const files = createHistoryFiles({ ...historyNative, open: (name, create) => {
      if (name === journal && operation === "vanished") return new HistoryNativeError({ kind: "missing" })

      return historyNative.open(name, create).pipe(Effect.map((file) => ({
        ...file,
        read: operation === "close" ? file.read : () => new HistoryNativeError({ kind: "missing" }),
        close: Effect.gen(function*() {
          closes++
          yield* file.close

          if (operation === "close") return yield* new HistoryNativeError({ kind: "missing" })
        }),
      })))
    } })

    const result = yield* files.verifyHistoryPath(path).pipe(Effect.exit)
    expect(Exit.isSuccess(result)).toBe(operation === "vanished")

    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ kind: "storage" })
    expect(closes).toBe(operation === "vanished" ? 0 : 1)
  })))

  it.effect("roundtrips verbatim data, uses idempotent insertion and keeps old records without age expiry", () => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const entry = event()
    yield* withStore(path, Effect.gen(function*() {
      yield* initializeHistory()
      yield* appendHistory([entry, entry])
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ command: string; ts: string; event_bytes: number }>`SELECT command, ts, event_bytes FROM events`
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ command: entry.command, ts: "1970-01-01T00:00:00.000Z" })
      expect(rows[0]?.event_bytes).toBeGreaterThan(0)
      const stored = yield* sql`SELECT * FROM events`
      expect(yield* decodeHistoryRow(stored[0])).toMatchObject({ detail_json: { version: 1, answers: null } })
      expect(yield* sql.unsafe("PRAGMA application_id")).toMatchObject([{ application_id: 0x4a455656 }])
      expect(yield* sql.unsafe("PRAGMA user_version")).toMatchObject([{ user_version: 1 }])
      expect(yield* sql.unsafe("PRAGMA journal_mode")).toMatchObject([{ journal_mode: "delete" }])
      expect(yield* sql.unsafe("PRAGMA secure_delete")).toMatchObject([{ secure_delete: 1 }])
      expect(yield* sql.unsafe("PRAGMA max_page_count")).toMatchObject([{ max_page_count: 8192 }])
      yield* verifyHistoryPath(path)
    }))
    expect((yield* Effect.promise(() => lstat(path.filename))).mode & 0o777).toBe(0o600)
    expect((yield* Effect.promise(() => lstat(join(root, "metrics")))).mode & 0o777).toBe(0o700)
  })))

  it.effect("enforces deterministic oldest row eviction transactionally", () => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    yield* withStore(path, Effect.gen(function*() {
      yield* initializeHistory()
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000) INSERT INTO events SELECT printf('%05d',x), '1970-01-01T00:00:00.000Z', 'ask', 'explicit-ask', 'synthetic', NULL, NULL, '{}', 100 FROM n")
      yield* appendHistory([event(1000)])
      expect(yield* sql`SELECT count(*) AS count FROM events`).toMatchObject([{ count: 10000 }])
      expect(yield* sql`SELECT id FROM events WHERE id='00001'`).toHaveLength(0)
      expect(yield* sql`SELECT command FROM events ORDER BY ts DESC LIMIT 1`).toMatchObject([{ command: "synthetic-1000-" }])
    }))
  })))

  it.effect("enforces the logical byte bound independently of row count", () => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    yield* withStore(path, Effect.gen(function*() {
      yield* initializeHistory()

      for (let index = 0; index < 360; index += 4) yield* appendHistory(Array.from({ length: 4 }, (_, offset) => event(index + offset, 60_000)))
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ bytes: number; count: number }>`SELECT SUM(event_bytes) AS bytes, count(*) AS count FROM events`
      expect(rows[0]?.bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
      expect(rows[0]?.count).toBeLessThan(360)
      expect(yield* sql`SELECT command FROM events ORDER BY ts DESC LIMIT 1`).toMatchObject([{ command: `synthetic-359-${"x".repeat(60_000)}` }])
    }))
  })))

  it.effect("rejects unrelated schemas without deleting their data", () => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    yield* withStore(path, Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE unfamiliar (value TEXT)`
      yield* sql`INSERT INTO unfamiliar VALUES ('synthetic-preserve')`
      expect(yield* initializeHistory().pipe(Effect.flip)).toMatchObject({ kind: "unsupported-schema" })
      expect(yield* sql`SELECT value FROM unfamiliar`).toMatchObject([{ value: "synthetic-preserve" }])
    }))
  })))

  it.effect.each(["symlink", "hardlink", "mode", "wal", "shm", "unknown"] as const)("rejects unsafe %s stores and preserves files", (kind) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    yield* Effect.promise(async () => {
      if (kind === "mode") await chmod(path.filename, 0o644)

      if (kind === "hardlink") await link(path.filename, join(root, "linked.sqlite"))

      if (kind === "symlink") {
        await rm(path.filename)
        await writeFile(join(root, "target.sqlite"), "synthetic-preserve", { mode: 0o600 })
        await symlink(join(root, "target.sqlite"), path.filename)
      }

      if (kind === "wal" || kind === "shm") await writeFile(`${path.filename}-${kind}`, "synthetic-preserve", { mode: 0o600 })

      if (kind === "unknown") await writeFile(join(root, "metrics", "unfamiliar"), "synthetic-preserve", { mode: 0o600 })
    })
    expect(yield* prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.flip)).toBeInstanceOf(Error)

    if (kind === "unknown") expect(yield* Effect.promise(() => readFile(join(root, "metrics", "unfamiliar"), "utf8"))).toBe("synthetic-preserve")
  })))

  it.effect("rejects symlink ancestors and nonprivate roots", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.promise(async () => {
      await mkdir(join(root, "private"), { mode: 0o700 })
      await symlink(join(root, "private"), join(root, "alias"))
    })
    expect(yield* prepareHistoryStore(join(root, "alias", "jevvy.jsonc")).pipe(Effect.flip)).toMatchObject({ kind: "unsafe-path" })
    yield* Effect.promise(() => chmod(join(root, "private"), 0o755))
    expect(yield* prepareHistoryStore(join(root, "private", "jevvy.jsonc")).pipe(Effect.flip)).toMatchObject({ kind: "unsafe-path" })
  })))

  it.effect.each(["symlink", "hardlink", "mode", "malformed"] as const)("preserves and rejects a %s rollback sidecar", (kind) => fixture((root) => Effect.gen(function*() {
    const path = yield* prepareHistoryStore(join(root, "jevvy.jsonc"))
    const journal = `${path.filename}-journal`
    const sentinel = "unfamiliar-journal-preserve".repeat(10)
    yield* Effect.promise(async () => {
      const target = join(root, "unfamiliar")
      await writeFile(target, sentinel, { mode: 0o600 })

      if (kind === "symlink") await symlink(target, journal)
      else if (kind === "hardlink") await link(target, journal)
      else await writeFile(journal, sentinel, { mode: kind === "mode" ? 0o644 : 0o600 })
    })
    expect(yield* prepareHistoryStore(join(root, "jevvy.jsonc")).pipe(Effect.flip)).toBeInstanceOf(Error)
    expect(yield* Effect.promise(() => readFile(journal, "utf8"))).toBe(sentinel)
  })))
})

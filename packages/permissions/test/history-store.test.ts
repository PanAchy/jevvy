import { describe, expect, it } from "@effect/vitest"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { HistoryEvent, decodeHistoryRow, projectHistory } from "../src/history.ts"
import { prepareHistoryStore, verifyHistoryPath } from "../src/opencode/history-files.ts"
import { appendHistory, initializeHistory } from "../src/opencode/history-store.ts"
import type { VerifiedHistoryPath } from "../src/opencode/history-files.ts"

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

describe.skipIf(process.platform === "win32")("private history SQL store", () => {
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

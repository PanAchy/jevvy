import { describe, expect, it } from "@effect/vitest"
import { Worker } from "node:worker_threads"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { projectHistory } from "../src/history.ts"
import { HistoryCommand, HistoryReply } from "../src/opencode/history-protocol.ts"

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "jevvy-history-worker-"))
    await chmod(root, 0o700)

    return root
  }),
  use,
  (root) => Effect.promise(() => rm(root, { recursive: true })),
)

const receive = (worker: Worker) => Effect.gen(function*() {
  const [raw] = yield* Effect.promise(() => once(worker, "message"))

  const frame = yield* Schema.decodeUnknownEffect(Schema.Union([Schema.Tuple([Schema.Literal(0)]), Schema.Tuple([Schema.Literal(1), HistoryReply])]), { onExcessProperty: "error" })(raw)

  return frame[0] === 0 ? "ready" : frame[1]
})

const start = (root: string) => Effect.acquireRelease(
  Effect.sync(() => new Worker(new URL("../src/opencode/history-worker.ts", import.meta.url), { workerData: { configPath: join(root, "jevvy.jsonc") } })),
  (worker) => Effect.promise(() => worker.terminate()),
)

const entry = () => {
  const event = projectHistory({ command: "printf 'synthetic-🔐'; echo '$(untrusted)'", result: "explicit-ask", provider: "custom", tsMs: 0, latencyMs: null }, randomUUID())

  if (event === undefined) throw new Error("invalid synthetic event")

  return event
}

describe.skipIf(process.platform === "win32")("native history workers", () => {
  it.effect("initializes concurrently, inserts duplicate ids once, and acknowledges scoped close", () => fixture((root) => Effect.scoped(Effect.gen(function*() {
    const first = yield* start(root)
    const second = yield* start(root)
    const ready = yield* Effect.all([receive(first), receive(second)], { concurrency: "unbounded" })
    expect(ready).toEqual(["ready", "ready"])
    const event = entry()
    first.postMessage([0, HistoryCommand.cases.Append.make({ sequence: 1, events: [event] })])
    second.postMessage([0, HistoryCommand.cases.Append.make({ sequence: 1, events: [event] })])
    expect(yield* Effect.all([receive(first), receive(second)], { concurrency: "unbounded" })).toEqual([HistoryReply.cases.Stored.make({ sequence: 1 }), HistoryReply.cases.Stored.make({ sequence: 1 })])
    const db = new DatabaseSync(join(root, "metrics", "history.sqlite"), { readOnly: true })

    try {
      expect(db.prepare("SELECT count(*) AS count, command FROM events").get()).toMatchObject({ count: 1, command: event.command })
    } finally { db.close() }

    first.postMessage([0, HistoryCommand.cases.Close.make({ sequence: 2 })])
    second.postMessage([0, HistoryCommand.cases.Close.make({ sequence: 2 })])
    expect(yield* Effect.all([receive(first), receive(second)], { concurrency: "unbounded" })).toEqual([HistoryReply.cases.Closed.make({ sequence: 2 }), HistoryReply.cases.Closed.make({ sequence: 2 })])
  }))))

  it.effect("recovers a genuine private hot rollback journal after a killed writer", () => fixture((root) => Effect.gen(function*() {
    const event = entry()
    yield* Effect.scoped(Effect.gen(function*() {
      const worker = yield* start(root)
      expect(yield* receive(worker)).toBe("ready")
      worker.postMessage([0, HistoryCommand.cases.Append.make({ sequence: 1, events: [event] })])
      expect(yield* receive(worker)).toEqual(HistoryReply.cases.Stored.make({ sequence: 1 }))
      worker.postMessage([0, HistoryCommand.cases.Close.make({ sequence: 2 })])
      expect(yield* receive(worker)).toEqual(HistoryReply.cases.Closed.make({ sequence: 2 }))
    }))
    const filename = join(root, "metrics", "history.sqlite")
    yield* Effect.acquireUseRelease(
      Effect.sync(() => spawn(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(filename)}); db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE'); db.prepare('UPDATE events SET command=?').run('synthetic-uncommitted-'+'z'.repeat(30000)); console.log('hot'); setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] })),
      (child) => Effect.promise(async () => {
        if (child.stdout === null) throw new Error("missing child stdout")
        await once(child.stdout, "data")
        expect((await lstat(`${filename}-journal`)).mode & 0o777).toBe(0o600)
        child.kill("SIGKILL")
        await once(child, "exit")
      }),
      (child) => Effect.sync(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") }),
    )
    yield* Effect.scoped(Effect.gen(function*() {
      const worker = yield* start(root)
      expect(yield* receive(worker)).toBe("ready")
      worker.postMessage([0, HistoryCommand.cases.Close.make({ sequence: 1 })])
      expect(yield* receive(worker)).toEqual(HistoryReply.cases.Closed.make({ sequence: 1 }))
    }))
    const db = new DatabaseSync(filename, { readOnly: true })

    try {
      expect(db.prepare("SELECT command FROM events").get()).toMatchObject({ command: event.command })
      expect(db.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" })
    } finally { db.close() }
  })))
})

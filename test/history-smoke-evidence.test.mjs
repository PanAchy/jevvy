import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { captureHistoryFailure, prepareHistoryTrace } from "../scripts/history-smoke-evidence.mjs"

const fixture = async (use) => {
  const root = mkdtempSync(join(tmpdir(), "jevvy-evidence-test-"))

  try { return await use(root) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

it("leaves tracing disabled without copying a preload or changing child options", () => fixture((root) => {
  expect(prepareHistoryTrace(root, false)).toEqual({ args: [], env: {}, file: undefined })
  expect(readdirSync(root)).toEqual([])
}))

it("does not patch workers or write a side file when an explicit preload has its flag OFF", () => fixture((root) => {
  const trace = prepareHistoryTrace(root, true)

  const result = spawnSync(process.execPath, [...trace.args, "--input-type=module", "-e", "import { Worker } from 'node:worker_threads'; process.stdout.write(Worker.name)"], { env: { ...process.env, JEVVY_SMOKE_TRACE: "0" }, encoding: "utf8", timeout: 5000 })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe("Worker")
  expect(result.stderr).toBe("")
  expect(existsSync(trace.file)).toBe(false)
}))

it("preserves database and journal bytes before read-only inspection fails", () => fixture(async (root) => {
  const metrics = join(root, "metrics")
  mkdirSync(metrics)
  writeFileSync(join(metrics, "history.sqlite"), "synthetic-invalid-database")
  writeFileSync(join(metrics, "history.sqlite-journal"), "synthetic-journal")
  const original = new Error("original synthetic query failure", { cause: new Error("inner boundary cause") })
  const owner = process.getuid ? { uid: process.getuid(), gid: process.getgid() } : undefined
  const directory = await captureHistoryFailure({ metricsPath: metrics, outputRoot: join(root, "artifacts"), owner, invocations: [{ command: "echo synthetic", stdoutBytes: 0, stderrBytes: 0 }] }, original)
  const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"))
  expect(summary.failure.stack).toBe(original.stack)
  expect(summary.failure.cause.message).toBe("inner boundary cause")
  expect((summary.databaseError ?? summary.database.rowsError).message).toMatch(/database/)

  if (owner) expect(lstatSync(directory).uid).toBe(owner.uid)

  for (const name of ["history.sqlite", "history.sqlite-journal"]) {
    expect(summary.files[name].copied).toBe(true)
    expect(readFileSync(join(directory, "metrics", name))).toEqual(readFileSync(join(metrics, name)))
  }
}))

it("retains schema inspection and the original no-table query error separately", () => fixture(async (root) => {
  const metrics = join(root, "metrics")
  mkdirSync(metrics)
  const database = new DatabaseSync(join(metrics, "history.sqlite"))
  database.exec("PRAGMA application_id=1246058070; PRAGMA user_version=1")
  database.close()
  const before = readFileSync(join(metrics, "history.sqlite"))
  const directory = await captureHistoryFailure({ metricsPath: metrics, outputRoot: join(root, "artifacts") }, new Error("no such table: events"))
  const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"))
  expect(summary.database.applicationId).toEqual([{ application_id: 1246058070 }])
  expect(summary.database.userVersion).toEqual([{ user_version: 1 }])
  expect(summary.database.objects).toEqual([])
  expect(summary.database.rowsError.message).toContain("no such table: events")
  expect(readFileSync(join(metrics, "history.sqlite"))).toEqual(before)
}))

it("bounds row previews and copies only allowlisted fixture data", () => fixture(async (root) => {
  const metrics = join(root, "metrics")
  mkdirSync(metrics)
  const database = new DatabaseSync(join(metrics, "history.sqlite"))
  database.exec("CREATE TABLE events(id,ts,effect,reason,command,model,latency_ms,detail_json,event_bytes)")
  const insert = database.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)")

  for (let index = 0; index < 40; index++) insert.run(String(index), "synthetic", "ask", "explicit-ask", "x".repeat(5000), null, null, "y".repeat(9000), 1)
  database.close()
  writeFileSync(join(metrics, "unknown"), "unknown-file-secret")
  writeFileSync(join(root, "jevvy.jsonc"), "configuration-secret")
  const directory = await captureHistoryFailure({ metricsPath: metrics, outputRoot: join(root, "artifacts") }, new Error("synthetic"))
  const text = readFileSync(join(directory, "summary.json"), "utf8")
  const summary = JSON.parse(text)
  expect(summary.database.rows).toHaveLength(32)
  expect(summary.database.rows[0].command).toHaveLength(4096)
  expect(summary.database.rows[0].detail_json).toHaveLength(8192)
  expect(summary.files.unknown.unsupported).toBe(true)
  expect(readdirSync(join(directory, "metrics"))).toEqual(["history.sqlite"])
  expect(text).not.toContain("unknown-file-secret")
  expect(text).not.toContain("configuration-secret")
}))

describe.skipIf(process.platform === "win32")("evidence pathname guards", () => {
  it("does not follow symlinks or hardlinks or copy oversized known files", () => fixture(async (root) => {
    const metrics = join(root, "metrics")
    mkdirSync(metrics)
    const secret = join(root, "auth.json")
    writeFileSync(secret, "never-copy-this-secret")
    symlinkSync(secret, join(metrics, "AGENTS.md"))
    linkSync(secret, join(metrics, "schema.sql"))
    writeFileSync(join(metrics, "event.schema.json"), "")
    truncateSync(join(metrics, "event.schema.json"), 65_537)
    const directory = await captureHistoryFailure({ metricsPath: metrics, outputRoot: join(root, "artifacts") }, new Error("synthetic"))
    const text = readFileSync(join(directory, "summary.json"), "utf8")
    const summary = JSON.parse(text)
    expect(readdirSync(join(directory, "metrics"))).toEqual([])
    expect(summary.files["AGENTS.md"]).toMatchObject({ symlink: true, copied: false })
    expect(summary.files["schema.sql"]).toMatchObject({ links: 2, copied: false })
    expect(summary.files["event.schema.json"]).toMatchObject({ size: 65_537, copied: false })
    expect(text).not.toContain("never-copy-this-secret")
  }))

  it("does not traverse a symlinked metrics directory", () => fixture(async (root) => {
    const source = join(root, "outside")
    mkdirSync(source)
    writeFileSync(join(source, "AGENTS.md"), "never-follow-directory-secret")
    const metrics = join(root, "metrics")
    symlinkSync(source, metrics)
    const directory = await captureHistoryFailure({ metricsPath: metrics, outputRoot: join(root, "artifacts") }, new Error("synthetic"))
    expect(readdirSync(join(directory, "metrics"))).toEqual([])
    expect(readFileSync(join(directory, "summary.json"), "utf8")).not.toContain("never-follow-directory-secret")
  }))
})

it("capture failure never replaces the primary exception", () => fixture(async (root) => {
  const outputRoot = join(root, "not-a-directory")
  writeFileSync(outputRoot, "preserve")
  const primary = new Error("primary failure")

  const invoke = async () => {
    await captureHistoryFailure({ metricsPath: join(root, "missing"), outputRoot }, primary)

    throw primary
  }

  await expect(invoke()).rejects.toBe(primary)
  expect(readFileSync(outputRoot, "utf8")).toBe("preserve")
}))

it("observes worker errors without suppressing native unhandled-error behavior", () => fixture((root) => {
  const trace = prepareHistoryTrace(root, true)

  const program = "import { Worker } from 'node:worker_threads'; const worker = new Worker(new URL('data:text/javascript,setInterval(() => {}, 1000)'), { execArgv: [] }); worker.emit('error', new Error('synthetic-unhandled-worker-error'))"

  const result = spawnSync(process.execPath, [...trace.args, "--input-type=module", "-e", program], { env: { ...process.env, ...trace.env }, encoding: "utf8", timeout: 5000 })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("synthetic-unhandled-worker-error")

  const text = readFileSync(trace.file, "utf8")
  expect(text).toContain('"event":"error"')
  expect(text).not.toContain("synthetic-unhandled-worker-error")
}))

it("traces actual worker protocol timing without frames, commands, keys or recursive worker patches", () => fixture((root) => {
  const trace = prepareHistoryTrace(root, true)

  const program = `
    import { Worker } from 'node:worker_threads'
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(\`import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ secret: 'private-frame-key' }); parentPort.postMessage([0]); parentPort.on('message', ([, body]) => { if (body._tag === 'Close') parentPort.postMessage([1, { _tag: 'Failed', kind: 'busy', message: 'private-frame-key' }]); parentPort.postMessage([1, body._tag === 'Append' ? { _tag: 'Stored', sequence: body.sequence, secret: 'private-frame-key' } : { _tag: 'Closed', sequence: body.sequence }]) })\`)), { execArgv: ${JSON.stringify(trace.args)} })
    worker.on('message', async (value) => {
      if (!Array.isArray(value)) return
      if (value[0] === 0) worker.postMessage([0, { _tag: 'Append', sequence: 1, events: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', command: 'never-trace-command' }], key: 'private-frame-key' }])
      else if (value[1]._tag === 'Stored') worker.postMessage([0, { _tag: 'Close', sequence: 2 }])
      else if (value[1]._tag === 'Closed') await worker.terminate()
    })
  `

  const result = spawnSync(process.execPath, [...trace.args, "--input-type=module", "-e", program], { env: { ...process.env, ...trace.env }, encoding: "utf8", timeout: 10_000 })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe("")
  const text = readFileSync(trace.file, "utf8")
  const events = text.trim().split("\n").map((line) => JSON.parse(line))
  expect(events.filter((entry) => entry.event === "spawn")).toHaveLength(1)
  expect(events.some((entry) => entry.event === "preload" && entry.thread > 0)).toBe(true)
  expect(events.some((entry) => entry.event === "invalid-frame")).toBe(true)
  expect(events.find((entry) => entry.tag === "Failed").kind).toBe("busy")
  const stages = ["spawn", "online", "platform-ready", "Append", "Stored", "Close", "Closed", "terminate"].map((stage) => events.find((entry) => entry.event === stage || entry.tag === stage))
  expect(stages.every(Boolean)).toBe(true)
  expect(stages.map((entry) => entry.timeMs)).toEqual(stages.map((entry) => entry.timeMs).toSorted((left, right) => left - right))
  expect(text).not.toContain("never-trace-command")
  expect(text).not.toContain("private-frame-key")
}))

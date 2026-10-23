import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

const writer = process.argv[2] === "--writer"

const packageRoot = resolve(process.argv[writer ? 3 : 2] ?? "packages/permissions")

const require = createRequire(join(packageRoot, "package.json"))

const Schema = await import(pathToFileURL(require.resolve("effect/Schema")))

const { HistoryCommand, HistoryReply } = await import(pathToFileURL(join(packageRoot, "dist/history/history-protocol.js")))

const { projectHistory, StoredHistoryRow, eventBytes } = await import(pathToFileURL(join(packageRoot, "dist/history.js")))

if (writer) {
  const root = process.argv[4]
  const runtime = process.versions.bun ? "bun" : "node"
  const command = `echo synthetic-${runtime}-${randomUUID()} && pwd > synthetic.txt`

  const event = projectHistory({
    command, provider: "custom", tsMs: 0, latencyMs: 3,
    result: { effect: "allow", judgments: [{ resource: command, effect: "allow", model: `actual-${runtime}`, answers: { synthetic: { type: "noul", noul: 0.25 } } }] },
  }, randomUUID())

  assert.ok(event)
  const worker = new Worker(pathToFileURL(join(packageRoot, "dist/history/history-worker.js")), { workerData: { configPath: join(root, "jevvy.jsonc") }, stdout: true, stderr: true })
  const inbox = []
  const waiting = []
  let failure

  const fail = (error) => {
    failure = error

    for (const pending of waiting.splice(0)) pending.reject(error)
  }

  worker.on("message", (message) => {
    const pending = waiting.shift()

    if (pending) pending.resolve(message)
    else inbox.push(message)
  })
  worker.on("error", fail)
  worker.on("messageerror", fail)
  worker.on("exit", (code) => fail(new Error(`writer exited before a requested reply: ${code}`)))
  worker.stdout?.resume()
  worker.stderr?.resume()
  const next = () => inbox.length > 0 ? Promise.resolve(inbox.shift()) : failure ? Promise.reject(failure) : new Promise((resolveReply, reject) => waiting.push({ resolve: resolveReply, reject }))
  let timer

  try {
    const protocol = async () => {
      assert.deepEqual(await next(), [0])
      const acknowledged = []

      for (const sequence of [1, 2]) {
        worker.postMessage([0, HistoryCommand.cases.Append.make({ sequence, events: [event] })])
        const frame = await next()
        assert.equal(frame[0], 1)
        assert.deepEqual(Schema.decodeUnknownSync(HistoryReply)(frame[1]), HistoryReply.cases.Stored.make({ sequence }))
        acknowledged.push(event.id)
      }

      worker.postMessage([0, HistoryCommand.cases.Close.make({ sequence: 3 })])
      const frame = await next()
      assert.equal(frame[0], 1)
      assert.deepEqual(Schema.decodeUnknownSync(HistoryReply)(frame[1]), HistoryReply.cases.Closed.make({ sequence: 3 }))

      return { runtime, version: process.versions.bun ?? process.version, sent: [event], acknowledged }
    }

    const result = await Promise.race([protocol(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("writer protocol exceeded its 15-second test deadline")), 15_000) })])
    console.log(JSON.stringify(result))
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
} else {
  assert.ok(process.env.BUN_BIN, "Set BUN_BIN to a Bun executable for the mixed-runtime writer smoke")
  const root = await mkdtemp(join(tmpdir(), "jevvy-history-writers-"))
  const script = fileURLToPath(import.meta.url)

  const run = (runtime) => new Promise((resolveResult, reject) => {
    const child = spawn(runtime, [script, "--writer", packageRoot, root], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("close", (code) => {
      clearTimeout(timer)

      if (code !== 0) reject(new Error(`mixed writer ${runtime} exited ${code}: ${stdout} ${stderr}`))
      else {
        try { resolveResult(JSON.parse(stdout)) } catch (error) { reject(error) }
      }
    })
  })

  try {
    const seed = await run(process.execPath)
    const settled = await Promise.allSettled([process.execPath, process.env.BUN_BIN, process.execPath, process.env.BUN_BIN].map(run))
    const failures = settled.filter((result) => result.status === "rejected")
    assert.equal(failures.length, 0, failures.map((result) => String(result.reason)).join("\n"))
    const results = [seed, ...settled.map((result) => result.value)]
    assert.equal(results.filter((result) => result.runtime === "bun").length, 2)
    const sent = results.flatMap((result) => result.sent)
    const acknowledged = new Set(results.flatMap((result) => result.acknowledged))
    assert.equal(sent.length, new Set(sent.map((event) => event.id)).size)
    assert.deepEqual(acknowledged, new Set(sent.map((event) => event.id)))
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(join(root, "metrics", "history.sqlite"), { readOnly: true })

    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
      assert.equal(database.prepare("PRAGMA application_id").get().application_id, 1246058070)
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1)
      const rows = database.prepare("SELECT * FROM events").all().map((row) => Schema.decodeUnknownSync(StoredHistoryRow)(row))
      assert.equal(rows.length, sent.length)
      assert.deepEqual(new Set(rows.map((row) => row.id)), acknowledged)

      for (const event of sent) assert.deepEqual(rows.find((row) => row.id === event.id), {
        id: event.id, ts: event.ts, effect: event.effect, reason: event.reason, command: event.command,
        model: event.model, latency_ms: event.latencyMs, detail_json: event.detail, event_bytes: eventBytes(event),
      })

      for (const path of [root, join(root, "metrics")]) assert.equal((await lstat(path)).mode & 0o777, 0o700)

      for (const name of await readdir(join(root, "metrics"))) {
        const info = await lstat(join(root, "metrics", name))
        assert.ok(info.isFile())
        assert.equal(info.mode & 0o777, 0o600)
        assert.equal(info.nlink, 1)
      }

      console.log(`Mixed Node/Bun writer smoke passed: ${JSON.stringify({ runtimes: results.map(({ runtime, version }) => ({ runtime, version })), sent: sent.length, acknowledged: acknowledged.size, stored: rows.length, duplicateAppends: sent.length, missingAcknowledged: 0, integrity: "ok" })}`)
    } finally { database.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
}

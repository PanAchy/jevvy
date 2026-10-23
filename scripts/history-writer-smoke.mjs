import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { inspectHistory, loadHistoryCodec, requirePositiveWriterControl } from "./history-smoke-contract.mjs"

const writer = process.argv[2] === "--writer"

const packageRoot = resolve(process.argv[writer ? 3 : 2] ?? "packages/permissions")

const require = createRequire(join(packageRoot, "package.json"))

const Schema = await import(pathToFileURL(require.resolve("effect/Schema")))

const { HistoryCommand, HistoryReply } = await import(pathToFileURL(join(packageRoot, "dist/history/history-protocol.js")))

const codec = await loadHistoryCodec(packageRoot)

const { projectHistory, eventBytes } = codec

const workerEntry = writer ? process.argv[5] : process.argv.includes("--worker") ? process.argv[process.argv.indexOf("--worker") + 1] : undefined

if (writer) {
  const root = process.argv[4]
  const runtime = process.versions.bun ? "bun" : "node"
  const command = `echo synthetic-${runtime}-${randomUUID()} && pwd > synthetic.txt`

  const event = projectHistory({
    command, provider: "custom", tsMs: 0, latencyMs: 3,
    result: { effect: "allow", judgments: [{ resource: command, effect: "allow", model: `actual-${runtime}`, answers: { synthetic: { type: "noul", noul: 0.25 } } }] },
  }, randomUUID())

  assert.ok(event)
  const worker = new Worker(pathToFileURL(workerEntry ?? join(packageRoot, "dist/history/history-worker.js")), { workerData: { configPath: join(root, "jevvy.jsonc") }, stdout: true, stderr: true })
  const inbox = []
  const waiting = []
  let failure
  let transportFailure
  let terminating = false

  const fail = (error) => {
    failure = error

    for (const pending of waiting.splice(0)) pending.reject(error)
  }

  worker.on("message", (message) => {
    const pending = waiting.shift()

    if (pending) pending.resolve(message)
    else inbox.push(message)
  })
  const transportFailed = (error) => { transportFailure = error; fail(error) }

  worker.on("error", transportFailed)
  worker.on("messageerror", transportFailed)
  worker.on("exit", (code) => {
    const error = new Error(`writer exited before a requested reply: ${code}`)

    if (code !== 0 && !(terminating && code === 1)) transportFailure = error
    fail(error)
  })
  worker.stdout?.resume()
  worker.stderr?.resume()
  const next = () => inbox.length > 0 ? Promise.resolve(inbox.shift()) : failure ? Promise.reject(failure) : new Promise((resolveReply, reject) => waiting.push({ resolve: resolveReply, reject }))
  let timer
  let result

  try {
    const protocol = async () => {
      const result = { runtime, version: process.versions.bun ?? process.version, expected: event, sent: [], acknowledged: [], outcomes: [], closed: false }

      const reply = async () => {
        const frame = await next()
        assert.ok(Array.isArray(frame) && frame.length === 2, "Invalid worker reply frame")
        assert.equal(frame[0], 1)
        const body = Schema.decodeUnknownSync(HistoryReply, { onExcessProperty: "error" })(frame[1])
        result.outcomes.push(body)

        if (HistoryReply.guards.Failed(body)) assert.equal(body.kind, "busy", "Only explicit busy is a permitted concurrent writer failure")

        return body
      }

      const first = await next()

      if (!Array.isArray(first) || first.length !== 1 || first[0] !== 0) {
        inbox.unshift(first)
        assert.equal((await reply())._tag, "Failed")

        return result
      }

      for (const sequence of [1, 2]) {
        worker.postMessage([0, HistoryCommand.cases.Append.make({ sequence, events: [event] })])
        result.sent.push(event.id)
        const body = await reply()

        if (HistoryReply.guards.Failed(body)) return result
        assert.deepEqual(body, HistoryReply.cases.Stored.make({ sequence }))
        result.acknowledged.push(event.id)
      }

      worker.postMessage([0, HistoryCommand.cases.Close.make({ sequence: 3 })])
      const body = await reply()

      if (HistoryReply.guards.Failed(body)) return result
      assert.deepEqual(body, HistoryReply.cases.Closed.make({ sequence: 3 }))
      result.closed = true

      return result
    }

    result = await Promise.race([protocol(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("writer protocol exceeded its 15-second test deadline")), 15_000) })])
  } finally {
    clearTimeout(timer)
    terminating = true
    await worker.terminate()
  }

  if (transportFailure) throw transportFailure
  assert.equal(inbox.length, 0, "Unconsumed writer replies after terminal outcome")
  console.log(JSON.stringify(result))
} else {
  const nodeOnly = process.argv.includes("--node-only")

  if (!nodeOnly) assert.ok(process.env.BUN_BIN, "Set BUN_BIN to a Bun executable for the mixed-runtime writer smoke")
  const root = await mkdtemp(join(await realpath(tmpdir()), "jevvy-history-writers-"))
  const script = fileURLToPath(import.meta.url)

  const run = (runtime) => new Promise((resolveResult, reject) => {
    const child = spawn(runtime, [script, "--writer", packageRoot, root, ...(workerEntry ? [workerEntry] : [])], { stdio: ["ignore", "pipe", "pipe"] })
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
    const controls = []

    for (const runtime of nodeOnly ? [process.execPath] : [process.execPath, process.env.BUN_BIN]) {
      const control = await run(runtime)
      const store = inspectHistory(join(root, "metrics"), codec)
      requirePositiveWriterControl(control, store.rows.find((row) => row.id === control.expected.id), eventBytes)
      controls.push(control)
      assert.equal(store.uninitialized, undefined)
      assert.deepEqual(new Set(store.rows.map((row) => row.id)), new Set(controls.map((entry) => entry.expected.id)))
    }

    const settled = await Promise.allSettled((nodeOnly ? [] : [process.execPath, process.env.BUN_BIN, process.execPath, process.env.BUN_BIN]).map(run))
    const failures = settled.filter((result) => result.status === "rejected")
    assert.equal(failures.length, 0, failures.map((result) => String(result.reason)).join("\n"))
    const results = [...controls, ...settled.map((result) => result.value)]
    assert.equal(results.filter((result) => result.runtime === "bun").length, nodeOnly ? 0 : 3)
    const offered = results.map((result) => result.expected)
    const sent = new Set(results.flatMap((result) => result.sent))
    const acknowledged = new Set(results.flatMap((result) => result.acknowledged))
    assert.equal(offered.length, new Set(offered.map((event) => event.id)).size)
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(join(root, "metrics", "history.sqlite"), { readOnly: true })

    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
      assert.equal(database.prepare("PRAGMA application_id").get().application_id, 1246058070)
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1)
      const rows = inspectHistory(join(root, "metrics"), codec).rows
      const stored = new Set(rows.map((row) => row.id))

      for (const id of acknowledged) assert.ok(stored.has(id), `Missing acknowledged ID: ${id}`)

      for (const id of stored) assert.ok(sent.has(id), `Unknown or unsent persisted ID: ${id}`)

      for (const result of results) {
        if (!stored.has(result.expected.id)) assert.ok(result.outcomes.some((outcome) => HistoryReply.guards.Failed(outcome) && outcome.kind === "busy"), "Missing writer row without explicit busy")
      }

      if (results.every((result) => result.closed)) {
        assert.deepEqual(stored, sent)
        assert.deepEqual(acknowledged, sent)
      }

      for (const row of rows) {
        const event = offered.find((entry) => entry.id === row.id)
        assert.deepEqual(row, {
          id: event.id, ts: event.ts, effect: event.effect, reason: event.reason, command: event.command,
          model: event.model, latency_ms: event.latencyMs, detail_json: event.detail, event_bytes: eventBytes(event),
        })
      }

      for (const path of [root, join(root, "metrics")]) assert.equal((await lstat(path)).mode & 0o777, 0o700)

      for (const name of await readdir(join(root, "metrics"))) {
        const info = await lstat(join(root, "metrics", name))
        assert.ok(info.isFile())
        assert.equal(info.mode & 0o777, 0o600)
        assert.equal(info.nlink, 1)
      }

      const missing = offered.flatMap((event) => stored.has(event.id) ? [] : [event.id])

      const terminalFaults = [
        ["invalid", ["invalid"]],
        ["unsafe", [1, HistoryReply.cases.Failed.make({ kind: "unsafe-path" })]],
        ["stored", [1, HistoryReply.cases.Stored.make({ sequence: 1 })]],
      ]

      for (const [name, frame] of terminalFaults) {
        const preload = join(root, `terminal-${name}.mjs`)
        await writeFile(preload, `
import workers from "node:worker_threads"
import { syncBuiltinESMExports } from "node:module"
if (workers.isMainThread) {
  const NativeWorker = workers.Worker
  workers.Worker = class extends NativeWorker {
    constructor() {
      super(new URL("data:text/javascript,setInterval(() => {}, 1000)"), { execArgv: [] })
      queueMicrotask(() => this.emit("message", [1, { _tag: "Failed", kind: "busy" }]))
    }
    terminate(...args) {
      this.emit("message", ${JSON.stringify(frame)})
      return super.terminate(...args)
    }
  }
  syncBuiltinESMExports()
}
`, { mode: 0o600 })
        const negative = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, "--writer", packageRoot, root], { encoding: "utf8", timeout: 20_000 })
        assert.equal(negative.error, undefined)
        assert.equal(negative.signal, null)
        assert.notEqual(negative.status, 0, `Busy followed by ${name} must fail`)
        assert.equal(negative.stdout, "")
        assert.match(negative.stderr, /Unconsumed writer replies after terminal outcome/)
      }

      console.log(`${nodeOnly ? "Node-only" : "Mixed Node/Bun"} writer smoke passed: ${JSON.stringify({ controls: controls.map(({ runtime, acknowledged }) => ({ runtime, acknowledged })), results, offered: offered.length, sent: sent.size, acknowledged: acknowledged.size, stored: rows.length, storedIds: [...stored], missing, classifiedBusy: missing.length, busyReplies: results.filter((result) => result.outcomes.some(HistoryReply.guards.Failed)).length, committedWithoutAck: [...stored].filter((id) => !acknowledged.has(id)), terminalFaultControls: terminalFaults.length, unknown: 0, missingAcknowledged: 0, integrity: "ok" })}`)
    } finally { database.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
}

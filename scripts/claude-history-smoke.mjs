import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { captureHistoryFailure, prepareHistoryTrace } from "./history-smoke-evidence.mjs"
import { checkHistoryCoverage, inspectHistory, loadHistoryCodec, readHistoryTrace, requirePositiveWriterControl } from "./history-smoke-contract.mjs"

const packed = resolve(process.argv[2])

const codec = await loadHistoryCodec(packed)

const temporary = mkdtempSync(join(realpathSync("/tmp"), "jevvy-standalone-history-"))

const trace = prepareHistoryTrace(temporary)

const invocations = []

const pending = new Set()

const hook = join(temporary, "claude-hook.mjs")

copyFileSync(join(packed, "dist", "claude-hook.js"), hook)

copyFileSync(join(packed, "dist", "claude-history-worker.js"), join(temporary, "claude-history-worker.js"))

let answer = "allow"

let calls = 0

const timings = []

const questions = new Map()

const server = createServer(async (request, response) => {
  const chunks = []

  for await (const chunk of request) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString())
  questions.set(input.state.resource, Object.keys(input.questions))
  calls++
  response.writeHead(answer === "failure" ? 503 : 200, { "content-type": "application/json" })
  response.end(answer === "malformed" ? "{}" : JSON.stringify(answer === "failure" ? { error: "never-store-provider-secret" } : {
    model: "standalone-actual-model",
    answers: Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: "noul", noul: answer === "ask" ? 1 : 0 }])),
  }))
})

await new Promise((ready) => server.listen(0, "127.0.0.1", ready))

let root = join(temporary, "config")

mkdirSync(root, { mode: 0o700 })

let configPath = join(root, "jevvy.jsonc")

const home = join(temporary, "home")

mkdirSync(home, { mode: 0o700 })

const settings = (enabled = true, review = true) => writeFileSync(configPath, JSON.stringify({
  provider: "custom", providers: { custom: { endpoint: `http://127.0.0.1:${server.address().port}`, model: "requested-model" } },
  metrics: { enabled }, permissions: { claude: { enabled: review } },
}), { mode: 0o600 })

let filename = join(root, "metrics", "history.sqlite")

const sessionStart = () => {
  const before = calls
  const startMs = Number(process.hrtime.bigint()) / 1e6

  const result = spawnSync(process.execPath, [...trace.args, hook], {
    env: { ...trace.env, PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), JEVVY_CONFIG: configPath },
    encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ session_id: "not-stored", transcript_path: "/not-stored", cwd: home, hook_event_name: "SessionStart", source: "startup" }),
  })

  const endMs = Number(process.hrtime.bigint()) / 1e6

  invocations.push({ pid: result.pid, event: "SessionStart", expected: "setup-diagnostic-only", startMs, endMs, durationMs: endMs - startMs, code: result.status, signal: result.signal, stdoutBytes: Buffer.byteLength(result.stdout ?? ""), stderrBytes: Buffer.byteLength(result.stderr ?? "") })

  assert.equal(result.status, 0)
  assert.equal(result.stderr, "", "Read-only SessionStart must not load SQLite or emit warnings")
  assert.equal(calls, before, "SessionStart must not call a provider")

  return result.stdout === "" ? undefined : JSON.parse(result.stdout).systemMessage
}

const invoke = (command, allowed = false) => {
  const running = new Promise((done, reject) => {
    const started = performance.now()
    const startMs = Number(process.hrtime.bigint()) / 1e6
    const expected = allowed ? "allow" : "silent-abstention"
    const providerOutcome = answer
    const child = spawn(process.execPath, [...trace.args, hook], { env: { ...trace.env, PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), JEVVY_CONFIG: configPath }, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let processError
    child.stdout.on("data", (data) => { stdout += data; stdoutBytes += data.length })
    child.stderr.on("data", (data) => { stderr += data; stderrBytes += data.length })
    child.on("error", (error) => { processError = error })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
    child.on("close", (code, signal) => {
      clearTimeout(timeout)
      const endMs = Number(process.hrtime.bigint()) / 1e6
      invocations.push({ pid: child.pid, event: "PermissionRequest", command, providerOutcome, expected, startMs, endMs, durationMs: endMs - startMs, code, signal, stdoutBytes, stderrBytes })

      try {
        if (processError) throw processError
        assert.equal(code, 0)
        assert.equal(stderr, "", "Bundled SQLite worker warnings must not reach hook stderr")
        assert.equal(stdout, allowed ? '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' : "")
        timings.push(Math.round(performance.now() - started))
        done()
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ session_id: "not-stored", prompt_id: "not-stored", transcript_path: "/not-stored", cwd: home,
      permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } }))
  })

  pending.add(running)
  running.then(() => pending.delete(running), () => pending.delete(running))

  return running
}

const rows = () => {
  const database = new DatabaseSync(filename, { readOnly: true })

  try { return database.prepare("SELECT * FROM events ORDER BY command").all() }
  finally { database.close() }
}

const expected = []

const coverage = () => {
  const store = inspectHistory(join(root, "metrics"), codec)
  assert.ok(store.rows.every((row) => expected.some((entry) => entry.command === row.command)), "Unexpected standalone observation")

  return checkHistoryCoverage({ expected, store, events: readHistoryTrace(trace.file), requireRole: true, validate: (row, observation) => {
    const judged = ["allow", "ask"].includes(observation.providerOutcome)
    assert.equal(row.reason, judged ? "judged" : "unavailable")
    assert.equal(row.effect, observation.providerOutcome === "allow" ? "allow" : "ask")
    assert.equal(row.model, judged ? "standalone-actual-model" : null)
    assert.equal(row.detail_json.provider, "custom")

    if (judged) assert.deepEqual(row.detail_json.answers, Object.fromEntries(observation.questions.map((name) => [name, { type: "noul", noul: observation.providerOutcome === "allow" ? 0 : 1 }])))

    if (observation.providerOutcome === "failure") {
      assert.deepEqual(Object.keys(row.detail_json.failure).sort(), ["kind", "provider", "retryAfterMs", "status"])
      assert.equal(row.detail_json.failure.status, 503)
    }

    assert.equal(JSON.stringify(row).includes("never-store-provider-secret"), false)
    assert.equal(JSON.stringify(row).includes("not-stored"), false)
  } })
}

const invokeStorageFault = async (command) => {
  for (const outcome of ["ask", "allow"]) {
    answer = outcome
    await invoke(command, outcome === "allow")
  }
}

try {
  settings(false)
  assert.equal(sessionStart(), undefined)
  await invoke("echo metrics-off", true)
  assert.equal(existsSync(filename), false)
  const beforeOff = calls
  settings(true, false)
  await invoke("echo review-off")
  assert.equal(calls, beforeOff)
  assert.equal(existsSync(filename), false)
  settings()
  assert.equal(sessionStart(), undefined)
  assert.equal(existsSync(join(root, "metrics")), false, "Healthy SessionStart must not create history paths")
  chmodSync(root, 0o755)

  try {
    assert.match(sessionStart(), /Jevvy Permissions review history is unavailable.*not private/)
    assert.equal(existsSync(join(root, "metrics")), false)
    settings(false)
    assert.equal(sessionStart(), undefined)
    writeFileSync(configPath, JSON.stringify({ provider: "typesafe", metrics: { enabled: true } }), { mode: 0o600 })
    const combined = sessionStart()
    assert.match(combined, /TYPESAFE_API_KEY/)
    assert.match(combined, /Jevvy Permissions review history is unavailable.*not private/)
  } finally {
    chmodSync(root, 0o700)
    settings()
  }

  for (const outcome of ["allow", "ask", "failure", "malformed"]) {
    answer = outcome
    await invoke(`echo ${outcome} && pwd > complete-command.txt`, outcome === "allow")
    const invocation = invocations.at(-1)
    expected.push({ ...invocation, questions: questions.get(invocation.command) })
    coverage()
  }

  const completed = inspectHistory(join(root, "metrics"), codec).rows
  assert.equal(JSON.stringify(completed).includes("never-store-provider-secret"), false)
  assert.equal(JSON.stringify(completed).includes("not-stored"), false)

  for (const row of completed) {
    assert.ok(Number.isFinite(row.latency_ms) && row.latency_ms >= 0)
    assert.ok(Number.isFinite(Date.parse(row.ts)))
    assert.equal(row.model, row.reason === "judged" ? "standalone-actual-model" : null)
  }

  answer = "ask"
  await Promise.all([1, 2, 3].map((index) => invoke(`echo concurrent-${index}`)))

  for (const invocation of invocations.filter((entry) => entry.command?.startsWith("echo concurrent-"))) expected.push({ ...invocation, questions: questions.get(invocation.command) })
  const historyCoverage = coverage()

  root = join(temporary, "storage-faults")
  mkdirSync(root, { mode: 0o700 })
  configPath = join(root, "jevvy.jsonc")
  filename = join(root, "metrics", "history.sqlite")
  settings()
  const positive = spawnSync(process.execPath, [...trace.args, fileURLToPath(new URL("./history-writer-smoke.mjs", import.meta.url)), "--writer", packed, root], { env: { ...process.env, ...trace.env }, encoding: "utf8", timeout: 20000 })
  assert.equal(positive.status, 0, positive.stderr)
  const control = JSON.parse(positive.stdout)
  requirePositiveWriterControl(control)
  const baseline = rows()
  assert.equal(baseline.length, 1)
  assert.equal(baseline[0].id, control.expected.id)
  inspectHistory(join(root, "metrics"), codec)
  const lock = new DatabaseSync(filename)
  lock.exec("BEGIN EXCLUSIVE")

  try { await invokeStorageFault("echo busy") }
  finally { lock.exec("ROLLBACK"); lock.close() }

  assert.deepEqual(rows(), baseline)
  chmodSync(root, 0o755)

  try { await invokeStorageFault("echo unsafe") }
  finally { chmodSync(root, 0o700) }

  assert.deepEqual(rows(), baseline)
  writeFileSync(join(root, "metrics", "unknown"), "preserve", { mode: 0o600 })
  await invokeStorageFault("echo unsupported-store")
  assert.equal(readFileSync(join(root, "metrics", "unknown"), "utf8"), "preserve")
  assert.deepEqual(rows(), baseline)

  if (trace.file) {
    const events = readHistoryTrace(trace.file)
    const closed = events.find((entry) => entry.pid === positive.pid && entry.tag === "Closed")
    assert.ok(closed, "Trace must observe a real scoped worker close")
    const stages = ["platform-ready", "Append", "Stored", "Close", "Closed"].map((stage) => events.find((entry) => entry.pid === closed.pid && entry.worker === closed.worker && (entry.event === stage || entry.tag === stage)))
    assert.ok(stages.every(Boolean), "Trace must include ready, Append, Stored, Close and Closed")
    assert.deepEqual(stages.map((entry) => entry.timeMs), stages.map((entry) => entry.timeMs).sort((left, right) => left - right))

    for (const invocation of invocations.filter((entry) => entry.event === "SessionStart" || ["echo metrics-off", "echo review-off"].includes(entry.command))) {
      assert.ok(events.some((entry) => entry.pid === invocation.pid && entry.event === "preload" && entry.thread === 0), "Excluded hook must still prove the test preload ran")
      assert.equal(events.some((entry) => entry.pid === invocation.pid && entry.event === "spawn"), false)
    }
  }

  console.log(`Standalone Claude history passed on Node ${process.versions.node}: expected=7 delivered=${historyCoverage.delivered.length} classifiedBusy=${historyCoverage.classifiedBusy.length} unknown=0; positive ACK+duplicate control; read-only SessionStart and disabled/OFF/busy/unsafe/unsupported-store silent; invocation milliseconds=${JSON.stringify(timings)}`)
} catch (error) {
  await Promise.allSettled(pending)
  await captureHistoryFailure({ metricsPath: join(root, "metrics"), tracePath: trace.file, invocations }, error)

  throw error
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  rmSync(temporary, { recursive: true, force: true })
}

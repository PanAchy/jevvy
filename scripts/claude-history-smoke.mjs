import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const packed = resolve(process.argv[2])

const temporary = mkdtempSync(join(realpathSync("/tmp"), "jevvy-standalone-history-"))

const hook = join(temporary, "claude-hook.mjs")

copyFileSync(join(packed, "dist", "claude-hook.js"), hook)

copyFileSync(join(packed, "dist", "claude-history-worker.js"), join(temporary, "claude-history-worker.js"))

let answer = "allow"

let calls = 0

const timings = []

const server = createServer(async (request, response) => {
  const chunks = []

  for await (const chunk of request) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString())
  calls++
  response.writeHead(answer === "failure" ? 503 : 200, { "content-type": "application/json" })
  response.end(answer === "malformed" ? "{}" : JSON.stringify(answer === "failure" ? { error: "never-store-provider-secret" } : {
    model: "standalone-actual-model",
    answers: Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: "noul", noul: answer === "ask" ? 1 : 0 }])),
  }))
})

await new Promise((ready) => server.listen(0, "127.0.0.1", ready))

const root = join(temporary, "config")

mkdirSync(root, { mode: 0o700 })

const configPath = join(root, "jevvy.jsonc")

const home = join(temporary, "home")

mkdirSync(home, { mode: 0o700 })

const settings = (enabled = true, review = true) => writeFileSync(configPath, JSON.stringify({
  provider: "custom", providers: { custom: { endpoint: `http://127.0.0.1:${server.address().port}`, model: "requested-model" } },
  metrics: { enabled }, permissions: { claude: { enabled: review } },
}), { mode: 0o600 })

const filename = join(root, "metrics", "history.sqlite")

const sessionStart = () => {
  const before = calls

  const result = spawnSync(process.execPath, [hook], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), JEVVY_CONFIG: configPath },
    encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ session_id: "not-stored", transcript_path: "/not-stored", cwd: home, hook_event_name: "SessionStart", source: "startup" }),
  })

  assert.equal(result.status, 0)
  assert.equal(result.stderr, "", "Read-only SessionStart must not load SQLite or emit warnings")
  assert.equal(calls, before, "SessionStart must not call a provider")

  return result.stdout === "" ? undefined : JSON.parse(result.stdout).systemMessage
}

const invoke = (command, allowed = false) => new Promise((done, reject) => {
  const started = performance.now()
  const child = spawn(process.execPath, [hook], { env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), JEVVY_CONFIG: configPath }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (data) => { stdout += data })
  child.stderr.on("data", (data) => { stderr += data })
  child.on("error", reject)
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
  child.on("exit", (code) => {
    clearTimeout(timeout)

    try {
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

const rows = () => {
  const database = new DatabaseSync(filename, { readOnly: true })

  try { return database.prepare("SELECT * FROM events ORDER BY command").all() }
  finally { database.close() }
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
    assert.equal(rows().length, ["allow", "ask", "failure", "malformed"].indexOf(outcome) + 1)
  }

  const completed = rows()
  assert.deepEqual(completed.map((row) => row.reason), ["judged", "judged", "unavailable", "unavailable"])
  assert.equal(JSON.stringify(completed).includes("never-store-provider-secret"), false)
  assert.equal(JSON.stringify(completed).includes("not-stored"), false)

  for (const row of completed) {
    assert.ok(Number.isFinite(row.latency_ms) && row.latency_ms >= 0)
    assert.ok(Number.isFinite(Date.parse(row.ts)))
    assert.equal(row.model, row.reason === "judged" ? "standalone-actual-model" : null)
  }

  answer = "ask"
  await Promise.all([1, 2, 3].map((index) => invoke(`echo concurrent-${index}`)))
  assert.equal(rows().length, 7)
  const lock = new DatabaseSync(filename)
  lock.exec("BEGIN EXCLUSIVE")

  try { await invokeStorageFault("echo busy") }
  finally { lock.exec("ROLLBACK"); lock.close() }

  assert.equal(rows().length, 7)
  chmodSync(root, 0o755)

  try { await invokeStorageFault("echo unsafe") }
  finally { chmodSync(root, 0o700) }

  assert.equal(rows().length, 7)
  writeFileSync(join(root, "metrics", "unknown"), "preserve", { mode: 0o600 })
  await invokeStorageFault("echo unsupported-store")
  assert.equal(readFileSync(join(root, "metrics", "unknown"), "utf8"), "preserve")
  assert.equal(rows().length, 7)
  console.log(`Standalone Claude history passed on Node ${process.versions.node}: read-only SessionStart setup diagnostics, 7 persisted rows, disabled/OFF/busy/unsafe/unsupported-store silent; invocation milliseconds=${JSON.stringify(timings)}`)
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  rmSync(temporary, { recursive: true, force: true })
}

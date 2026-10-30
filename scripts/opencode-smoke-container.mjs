#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { withPermissionSmoke } from "./opencode-permission-smoke.mjs"
import { verifyControlCommand } from "./opencode-control-smoke.mjs"
import { captureHistoryFailure, prepareHistoryTrace } from "./history-smoke-evidence.mjs"
import { checkHistoryCoverage, inspectHistory, loadHistoryCodec, readHistoryTrace, requirePositiveHookHistory } from "./history-smoke-contract.mjs"

const root = "/tmp/jevvy-opencode-smoke"

const opencodeVersion = process.env.JEVVY_OPENCODE_VERSION ?? "2.2.4"

const project = join(root, "project")

const home = join(root, "home")

mkdirSync(root, { recursive: true, mode: 0o700 })

const trace = prepareHistoryTrace(root)

const invocations = []

const pending = new Set()

const preserveFailure = async (error) => {
  await Promise.allSettled(pending)
  const uid = process.env.JEVVY_SMOKE_ARTIFACT_UID
  const gid = process.env.JEVVY_SMOKE_ARTIFACT_GID
  const owner = /^\d+$/.test(uid ?? "") && /^\d+$/.test(gid ?? "") ? { uid: Number(uid), gid: Number(gid) } : undefined
  await captureHistoryFailure({ metricsPath: join(root, "metrics"), tracePath: trace.file, invocations, outputRoot: "/tmp/jevvy-history-artifacts", owner }, error)

  throw error
}

mkdirSync(project, { recursive: true })

mkdirSync(home, { recursive: true })

writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))

const install = spawnSync(
  "npm",
  ["install", "--no-audit", "--no-fund", "--ignore-scripts=false", "/tmp/jevvy.tgz", `@opencode/cli@${opencodeVersion}`, "bun@1.3.13"],
  {
    cwd: root,
    env: {
      ...process.env,
      npm_config_fetch_retries: "1",
      npm_config_fetch_retry_maxtimeout: "10000",
      npm_config_fetch_timeout: "30000",
    },
    stdio: "inherit",
    timeout: 240_000,
  },
)

if (install.status !== 0) throw new Error(`consumer install failed with status ${String(install.status)}`)

const serverPassword = "jevvy-host-smoke"

const authorization = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`

writeFileSync(join(project, "opencode.jsonc"), `${JSON.stringify({ plugins: ["@jevvy/permissions"] }, null, 2)}\n`)

const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  JEVVY_CONFIG: join(root, "jevvy.jsonc"),
  OPENCODE_PASSWORD: serverPassword,
  OPENCODE_API_KEY: "",
  TYPESAFE_API_KEY: "",
  JEVVY_SMOKE_MODEL_KEY: "credential-free-smoke",
  NO_COLOR: "1",
}

const executable = join(root, "node_modules", ".bin", "opencode")

const inspectPlugin = async (port, expectedProblem, exercise) => {
  const server = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const diagnostics = []

  server.stdout.on("data", (chunk) => diagnostics.push(String(chunk)))
  server.stderr.on("data", (chunk) => diagnostics.push(String(chunk)))

  try {
    const baseUrl = `http://127.0.0.1:${port}`

    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/api/info`, { headers: { authorization } })

        if (response.ok) break
      } catch {
        // The foreground server is still starting.
      }

      if (attempt === 119) throw new Error(`OpenCode did not start\n${diagnostics.join("").slice(-4000)}`)

      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }

    const session = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: project } }),
    })

    if (!session.ok) throw new Error(`session creation failed: ${session.status} ${await session.text()}`)

    const url = new URL(`${baseUrl}/api/plugin`)

    url.searchParams.set("location[directory]", project)

    let lastPlugin

    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(url, { headers: { authorization } })

      if (!response.ok) throw new Error(`plugin status failed: ${response.status} ${await response.text()}`)

      const body = await response.json()

      lastPlugin = body.data?.find((entry) => entry.id === "jevvy.permissions")

      if (lastPlugin?.state?.status === "active") {
        const status = await fetch(`${baseUrl}/api/rpc/jevvy.permissions.control/get?location[directory]=${encodeURIComponent(project)}`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({}),
        })

        if (!status.ok) throw new Error(`Jevvy controls were not available: ${status.status} ${await status.text()}`)
        const control = await status.json()

        if (expectedProblem !== undefined && !control.output?.problem?.includes(expectedProblem)) {
          throw new Error(`Jevvy setup diagnostic was not actionable: ${JSON.stringify(control)}`)
        }

        if (expectedProblem === undefined && control.output?.enabled !== true) {
          throw new Error(`Jevvy controls did not default to enabled: ${JSON.stringify(control)}`)
        }

        if (expectedProblem === undefined && control.output?.problem !== undefined) {
          throw new Error(`Jevvy reported an unexpected setup problem: ${JSON.stringify(control)}`)
        }

        if (exercise !== undefined) {
          const api = async (method, path, body) => {
            const options = {
              method,
              headers: { authorization, "content-type": "application/json" },
              signal: AbortSignal.timeout(20_000),
            }

            if (body !== undefined) options.body = JSON.stringify(body)

            const result = await fetch(`${baseUrl}${path}`, options)

            if (!result.ok) throw new Error(`${method} ${path}: ${result.status} ${await result.text()}`)

            return result.status === 204 ? undefined : result.json()
          }

          try {
            await exercise(api)
          } catch (error) {
            throw new Error(`shell permission smoke failed\n${diagnostics.join("").slice(-4000)}`, { cause: error })
          }
        }

        return
      }

      if (lastPlugin?.state?.status === "failed") {
        throw new Error(`Jevvy plugin failed unexpectedly: ${JSON.stringify(lastPlugin)}`)
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }

    throw new Error(`Jevvy plugin did not activate: ${JSON.stringify(lastPlugin)}\n${diagnostics.join("").slice(-4000)}`)
  } finally {
    server.kill("SIGTERM")

    if (server.exitCode === null) await new Promise((resolveExit) => server.once("exit", resolveExit))
  }
}

await inspectPlugin(4096, "npx @jevvy/permissions init")

writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({
  provider: "custom",
  providers: {
    custom: {
      endpoint: "http://127.0.0.1:9/v1/decisions",
      model: "smoke-model",
    },
  },
}, null, 2)}\n`, { mode: 0o600 })

await inspectPlugin(4097, undefined, (api) => verifyControlCommand(api, project))

writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({
  provider: "laya",
  providers: { laya: {} },
}, null, 2)}\n`, { mode: 0o600 })

await inspectPlugin(4098, "providers.laya.policy")

writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({
  provider: "laya",
  providers: { laya: { policy: {
    checkpoint: "english",
    questions: { harmful: { type: "noul", instructions: "Is this command risky?", threshold: 0 } },
  } } },
}, null, 2)}\n`, { mode: 0o600 })

await inspectPlugin(4099)

let permissionPort = 4100

await withPermissionSmoke(project, async (endpoint, exercise, reviewAskPatterns) => {
  writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({
    provider: "custom",
    providers: { custom: { endpoint, model: "smoke-model" } },
    permissions: { reviewAskPatterns },
  }, null, 2)}\n`, { mode: 0o600 })

  await inspectPlugin(permissionPort++, undefined, exercise)
})

const historyPath = join(root, "metrics", "history.sqlite")

if (existsSync(historyPath)) await preserveFailure(new Error("default-off history created a database"))

const claudeSettings = join(root, "claude-history")

mkdirSync(claudeSettings, { mode: 0o700 })

writeFileSync(join(claudeSettings, "settings.json"), JSON.stringify({ permissions: { ask: ["Bash(echo jevvy-claude-concurrent-*)"] } }), { mode: 0o600 })

const invokeClaudeWriter = (index) => {
  const running = new Promise((resolve, reject) => {
    const startMs = Number(process.hrtime.bigint()) / 1e6

    const child = spawn(process.execPath, [...trace.args, join(root, "node_modules", "@jevvy", "permissions", "dist", "claude-hook.js")], {
      env: { ...environment, ...trace.env, CLAUDE_CONFIG_DIR: claudeSettings }, stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let processError
    child.stdout.on("data", (chunk) => { stdout += chunk; stdoutBytes += chunk.length })
    child.stderr.on("data", (chunk) => { stderr += chunk; stderrBytes += chunk.length })
    child.on("error", (error) => { processError = error })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
    child.on("close", (code, signal) => {
      clearTimeout(timeout)
      const endMs = Number(process.hrtime.bigint()) / 1e6
      invocations.push({ pid: child.pid, event: "PermissionRequest", command: `echo jevvy-claude-concurrent-${index}`, expected: "silent-abstention", startMs, endMs, durationMs: endMs - startMs, code, signal, stdoutBytes, stderrBytes })

      if (processError) reject(processError)
      else if (code !== 0 || stdout !== "" || stderr !== "") reject(new Error(`Concurrent Claude writer violated silent abstention: ${code} ${stdout} ${stderr}`))
      else resolve()
    })
    child.stdin.end(JSON.stringify({ session_id: "not-stored", prompt_id: "not-stored", transcript_path: "/not-stored", cwd: project,
      permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: `echo jevvy-claude-concurrent-${index}` } }))
  })

  pending.add(running)
  running.then(() => pending.delete(running), () => pending.delete(running))

  return running
}

let historyPasses = 0

const expectedOpenCode = []

await withPermissionSmoke(project, async (endpoint, exercise, reviewAskPatterns) => {
  writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({
    provider: "custom",
    providers: { custom: { endpoint, model: "smoke-model" } },
    metrics: { enabled: true },
    permissions: { reviewAskPatterns },
  }, null, 2)}\n`, { mode: 0o600 })

  const pass = historyPasses++

  await invokeClaudeWriter(pass * 4)
  await inspectPlugin(4101, undefined, (api) => Promise.all([
    exercise(api),
    Promise.all([1, 2, 3].map((index) => invokeClaudeWriter(pass * 4 + index))),
  ]))
}, (entry) => expectedOpenCode.push(entry)).catch(preserveFailure)

const { DatabaseSync } = await import("node:sqlite")

const verifyHistory = async () => {
  const codec = await loadHistoryCodec(join(root, "node_modules", "@jevvy", "permissions"))
  const store = inspectHistory(join(root, "metrics"), codec)
  const history = new DatabaseSync(historyPath, { readOnly: true })

  try {
    const rows = history.prepare("SELECT command, effect, reason, model, latency_ms FROM events").all()

    if (!rows.some((row) => row.command === "echo jevvy-reviewed" && row.effect === "allow" && row.reason === "judged" && row.model === "smoke-model")) throw new Error("packed worker did not retain the real boundary judgment")

    if (!rows.some((row) => row.reason === "explicit-ask" && row.model === null && row.latency_ms === null)) throw new Error("packed worker did not retain a truthful explicit-ask skip")

    if (!rows.some((row) => row.reason === "unavailable")) throw new Error("packed worker did not retain an unavailable review")

    const claudeRows = rows.filter((row) => String(row.command).startsWith("echo jevvy-claude-concurrent-"))

    const expected = Array.from({ length: historyPasses * 4 }, (_, index) => `echo jevvy-claude-concurrent-${index}`)
    const invalid = claudeRows.filter((row) => !expected.includes(row.command) || row.reason !== "explicit-ask" || row.effect !== "ask" || row.model !== null || row.latency_ms !== null)

    if (invalid.length > 0) throw new Error(`Invalid Claude observations: ${JSON.stringify(invalid)}`)

    const coverage = checkHistoryCoverage({ expected: expected.map((command) => ({ command, pid: invocations.find((entry) => entry.command === command)?.pid })), store, events: readHistoryTrace(trace.file), lifetime: "invocation", requireRole: true, validate: (row) => {
      if (row.reason !== "explicit-ask" || row.effect !== "ask" || row.model !== null || row.latency_ms !== null || JSON.stringify(row.detail_json) !== JSON.stringify({ version: 1, provider: null, answers: null, failure: null })) throw new Error("Invalid complete Claude observation")
    } })

    requirePositiveHookHistory({ coverages: [coverage], requireAck: trace.file !== undefined })

    const remaining = [...expectedOpenCode]

    for (const row of store.rows.filter((row) => !expected.includes(row.command))) {
      const candidate = remaining.findIndex((entry) => {
        const judged = entry.mode === "allow" || entry.mode === "ask" || entry.mode.startsWith("inquiry:")
        const reason = entry.mode === "explicit-ask" ? "explicit-ask" : judged ? "judged" : "unavailable"

        if (row.command !== entry.command || row.reason !== reason || row.effect !== (entry.mode === "allow" ? "allow" : "ask") || row.model !== (judged ? "smoke-model" : null)) return false
        const answers = judged ? Object.fromEntries(entry.questions.map((key) => [key, { type: "noul", noul: entry.mode === "ask" || entry.mode === `inquiry:${key}` ? 1 : 0 }])) : null

        return isDeepStrictEqual(row.detail_json.answers, answers)
      })

      assert.ok(candidate >= 0, `Unknown OpenCode observation payload: ${JSON.stringify(row)}`)
      const [entry] = remaining.splice(candidate, 1)
      assert.equal(row.detail_json.provider, entry.mode === "explicit-ask" ? null : "custom")

      if (entry.mode === "failure") {
        assert.equal(row.detail_json.failure.provider, "custom")
        assert.equal(row.detail_json.failure.status, 503)
      }

      assert.equal(JSON.stringify(row).includes("Smoke provider unavailable"), false)
    }

    console.log(`Actual OpenCode history payloads validated: ${store.rows.length - claudeRows.length} stored, ${expectedOpenCode.length} eligible fixture observations`)

    if (rows.some((row) => String(row.command).startsWith("echo jevvy-allowed") || String(row.command).startsWith("echo jevvy-denied"))) throw new Error("native finalized outcomes entered history")
  } finally { history.close() }
}

await verifyHistory().catch(preserveFailure)

const writers = spawnSync(process.execPath, ["/tmp/history-writer-smoke.mjs", join(root, "node_modules", "@jevvy", "permissions")], {
  env: { ...environment, BUN_BIN: join(root, "node_modules", ".bin", "bun") }, stdio: "inherit", timeout: 60_000,
})

if (writers.status !== 0) await preserveFailure(new Error(`acknowledged mixed-runtime writer smoke failed: ${writers.status}`))

console.log(`OpenCode ${opencodeVersion} host smoke passed: setup diagnostics, activation, real shell permission review, packed worker history OFF/ON, concurrent Node Claude and Bun OpenCode SQLite writers, disposal`)

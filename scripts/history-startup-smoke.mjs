import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { captureHistoryFailure, prepareHistoryTrace } from "./history-smoke-evidence.mjs"
import { checkHistoryCoverage, inspectHistory, loadHistoryCodec, readHistoryTrace } from "./history-smoke-contract.mjs"

const packed = resolve(process.argv[2])

const root = mkdtempSync(join(tmpdir(), "jevvy-history-startup-"))

const home = join(root, "home")

const config = join(root, "config")

const metrics = join(config, "metrics")

const trace = prepareHistoryTrace(root, true)

try {
  for (const path of [home, config, join(home, ".claude")]) mkdirSync(path, { mode: 0o700 })
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: ["Bash(echo *)"] } }))
  const configPath = join(config, "jevvy.jsonc")
  writeFileSync(configPath, JSON.stringify({ provider: "custom", providers: { custom: { endpoint: "http://127.0.0.1:9/unused", model: "fixture" } }, metrics: { enabled: true } }), { mode: 0o600 })
  const hold = join(root, "hold-worker.mjs")
  writeFileSync(hold, 'import { isMainThread } from "node:worker_threads"; if (!isMainThread) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);')

  const command = "echo synthetic-cold-start"

  const child = spawnSync(process.execPath, [...trace.args, "--import", pathToFileURL(hold).href, join(packed, "dist", "claude-hook.js")], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), JEVVY_CONFIG: configPath, ...trace.env },
    input: JSON.stringify({ session_id: "synthetic", prompt_id: "synthetic", transcript_path: "/unused", permission_mode: "default", cwd: home, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8", timeout: 5000,
  })

  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, "")
  assert.equal(child.stderr, "")
  const events = readHistoryTrace(trace.file)
  const codec = await loadHistoryCodec(packed)
  const store = inspectHistory(metrics, codec)
  const result = checkHistoryCoverage({ expected: [{ command, pid: child.pid }], store, events, requireRole: true, lifetime: "invocation" })
  assert.equal(result.classifiedStartup.length, 1)
  assert.equal(result.delivered.length, 0)
  assert.equal(result.acknowledged.length, 0)
  assert.equal(events.some((entry) => entry.event === "frame" || entry.event === "platform-ready"), false)
  console.log("Packed Claude cold-start control passed: held worker stopped before readiness; silent abstention and no claimed write")
} catch (error) {
  await captureHistoryFailure({ metricsPath: metrics, tracePath: trace.file }, error)
  throw error
} finally {
  rmSync(root, { recursive: true, force: true })
}

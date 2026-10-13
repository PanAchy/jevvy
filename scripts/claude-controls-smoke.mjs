import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createContext, SourceTextModule } from "node:vm"

const root = resolve(process.argv[2] ?? "packages/permissions")

const temporary = mkdtempSync(join(tmpdir(), "jevvy-native-controls-"))

const config = join(temporary, "jevvy.jsonc")

const timers = new Map()

const handlers = new Map()

const diagnostics = []

const registrations = []

let renders = 0

let delayedRead

let readEntered

let initialRender

let pulseScheduled

const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}

const control = (operation, harness = "claude") => {
  const result = spawnSync(process.execPath, [join(root, "dist", "claude-control.js"), operation, harness], {
    encoding: "utf8",
    env: { ...process.env, JEVVY_CONFIG: config },
  })

  ensure(result.status === 0, `bundled control failed: ${result.stderr}`)

  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}

const $ = {
  plugin: { root },
  process: { run: async (arguments_) => {
    if (arguments_[2] === "read" && delayedRead !== undefined) {
      readEntered?.()

      return delayedRead
    }

    return control(arguments_[2])
  } },
  clock: { after: (interval, tick) => {
    const once = () => { timers.delete(once); tick() }

    timers.set(once, interval)

    if (interval === 250) pulseScheduled?.()

    return { cancel: () => timers.delete(once) }
  } },
  ui: {
    invalidate: () => { renders++;

 if (renders > 1) initialRender?.() },
    toast: (message) => { diagnostics.push(message); initialRender?.() },
  },
  command: { register: async (command) => { registrations.push(command) } },
}

const badge = async () => {
  const drawing = await handlers.get("ui.render")($, {}, async () => ({ type: "native-mode" }))

  return drawing.children[1]
}

const pulse = async (last = false) => {
  const rendered = new Promise((resolveFrame) => { initialRender = resolveFrame })
  const scheduled = new Promise((resolveTimer) => { pulseScheduled = resolveTimer })
  const pending = [...timers].find(([, interval]) => interval === 250)
  ensure(pending !== undefined, "pulse did not schedule its next tick")
  pending[0]()
  await rendered

  if (!last) await scheduled
}

try {
  writeFileSync(config, '{"permissions":{"opencode":{"enabled":false}}}', { mode: 0o600 })

  const context = createContext({
    console, TextEncoder, TextDecoder, AbortController, AbortSignal, URL, URLSearchParams, crypto: globalThis.crypto,
    h: (type, props, ...children) => ({ type, props, children }),
  })

  const module = new SourceTextModule(readFileSync(join(root, "dist", "claude-controls.js"), "utf8"), { context })
  await module.link(() => { throw new Error("native controls must be dependency-free") })
  await module.evaluate()
  module.namespace.register((event, filter, handler) => handlers.set(event, handler ?? filter))
  const firstFrame = new Promise((resolveFrame) => { initialRender = resolveFrame })
  await handlers.get("session.start")($, {}, async (event) => event)
  await firstFrame
  ensure(diagnostics.length === 0, `initial native configuration read failed: ${JSON.stringify(diagnostics)}`)
  ensure(registrations[0]?.name === "jevvy", "native /jevvy was not registered")
  ensure((await badge()).props.color === "green", "existing configurations must start enabled")
  await handlers.get("command.run")($, {}, async (event) => event)
  ensure(JSON.parse(control("read").stdout).enabled === false, "/jevvy did not persist OFF")
  ensure((await badge()).props.color === "red", "OFF indicator is not red")
  await pulse()
  ensure((await badge()).props.dimColor === true, "indicator did not blink")
  await pulse()
  await pulse()
  await pulse(true)
  ensure((await badge()).props.dimColor === false, "indicator did not stop blinking")
  ensure(timers.size === 1, "pulse timer leaked")
  await handlers.get("command.run")($, {}, async (event) => event)
  ensure((await badge()).props.color === "green", "ON indicator is not green")
  ensure(JSON.parse(readFileSync(config, "utf8")).permissions.opencode.enabled === false, "Claude changed OpenCode's setting")
  control("toggle")
  const externalFrame = new Promise((resolveFrame) => { initialRender = resolveFrame })

  for (const [tick, interval] of [...timers]) if (interval === 2000) tick()
  await externalFrame
  ensure((await badge()).props.color === "red", "native indicator missed another process's change")
  let finishRead
  delayedRead = new Promise((resolveRead) => { finishRead = resolveRead })
  const entered = new Promise((resolveEntered) => { readEntered = resolveEntered })

  for (const [tick, interval] of [...timers]) if (interval === 2000) tick()
  await entered
  await handlers.get("session.end")($, {}, async (event) => event)
  const renderCount = renders
  finishRead({ exitCode: 0, stdout: '{"enabled":true}', stderr: "" })
  await Promise.resolve()
  ensure(timers.size === 0, "native timers survived session end")
  ensure(renders === renderCount, "pending refresh rendered after session end")
  ensure(diagnostics.length === 0, `unexpected native diagnostics: ${JSON.stringify(diagnostics)}`)
  let rejectRead
  delayedRead = new Promise((_, reject) => { rejectRead = reject })
  const restarted = handlers.get("session.start")($, {}, async (event) => event)
  rejectRead(new Error("unreadable restarted configuration"))
  await restarted
  ensure((await badge()).props.color === "gray", "a restarted unreadable session retained its old indicator state")
  await handlers.get("session.end")($, {}, async (event) => event)
  ensure(timers.size === 0, "restarted native timers survived session end")
  console.log("Claude native controls smoke passed: sandbox loading, /jevvy, independent persistence, blinking, external refresh, and cleanup")
} finally {
  for (const tick of timers.keys()) timers.delete(tick)
  rmSync(temporary, { recursive: true, force: true })
}

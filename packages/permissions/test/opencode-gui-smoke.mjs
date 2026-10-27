import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import * as Effect from "effect"
import * as Solid from "solid-js"
import * as gui from "@opencode/plugin/gui"
import * as rpc from "@opencode/plugin/rpc"

const root = resolve(process.argv[2] ?? "packages/permissions")

const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}

const until = async (check, message) => {
  const deadline = Date.now() + 5_000

  while (!check()) {
    if (Date.now() > deadline) throw new Error(message)

    await new Promise((done) => setTimeout(done, 10))
  }
}

const modules = new Map([
  ["effect", Effect], ["solid-js", Solid],
  ["@opencode/plugin/gui", gui], ["@opencode/plugin/rpc", rpc],
])

const exports = {}

runInNewContext(readFileSync(resolve(root, "dist/gui-experimental.cjs"), "utf8"), {
  exports,
  require: (name) => {
    ensure(modules.has(name), `GUI bundle unexpectedly requires ${name}`)

    return modules.get(name)
  },
}, { filename: "gui-experimental.cjs" })

const commands = new Set()

const diagnostics = []

const [session, setSession] = Solid.createSignal()

const server = (directory, enabled) => {
  const changed = new Set()
  const state = { enabled, reads: 0, toggles: 0, changed, problem: undefined, pending: undefined, signal: undefined }

  const client = {
    rpc: () => ({
      get: async (_input, options) => {
        ensure(options.location.directory === directory, "GUI read used another server's directory")
        state.reads++
        state.signal = options.signal

        return state.pending ?? { enabled: state.enabled, problem: state.problem }
      },
      toggle: async (_input, options) => {
        ensure(options.location.directory === directory, "GUI toggle used another server's directory")
        state.toggles++
        state.enabled = !state.enabled

        return { enabled: state.enabled }
      },
      events: { on: (name, listener) => {
        ensure(name === "changed", "GUI subscribed to the wrong event")
        changed.add(listener)

        return () => changed.delete(listener)
      } },
    }),
  }

  return {
    state,
    session: { key: directory, location: { directory }, server: { client, connected: true } },
    emit: () => { for (const listener of changed) listener() },
  }
}

const a = server("/fixture/a", true)

const b = server("/fixture/b", false)

let pill

let contribution

const dispose = Solid.createRoot((dispose) => {
  exports.default.setup({
    sessions: { current: session },
    toast: { show: (toast) => diagnostics.push(toast) },
    add: (token, item) => {
      if (token === gui.Command) {
        commands.add(item)
        Solid.onCleanup(() => commands.delete(item))
      } else if (token === gui.ComposerPill) {
        ensure(item.id === "review", "GUI must register its review composer pill")
        contribution = item
        Solid.createRenderEffect(() => { pill = item.show({ session: session() ?? a.session }) })
        Solid.onCleanup(() => { pill = undefined })
      } else {
        throw new Error("Unexpected GUI contribution")
      }
    },
  })

  return dispose
})

try {
  ensure(pill === undefined, "GUI must not show a pill without a routed session")
  setSession(a.session)
  await until(() => pill?.tone === "success", "GUI did not load ON")
  ensure(pill.label === "Jevvy" && pill.icon === "circle-check", "GUI ON must use its compact label and success icon")
  ensure(pill.title.includes("enabled"), "GUI must explain its enabled state accessibly")
  ensure(commands.size === 1, "GUI must register exactly one toggle command")
  ensure(contribution.show({ session: b.session }) === undefined, "GUI must not show another session's status")

  pill.run()
  await until(() => pill?.tone === "danger", "GUI click did not toggle OFF")
  ensure(a.state.toggles === 1, "GUI click must persist exactly one toggle")
  ensure(pill.icon === "circle-x" && pill.title.includes("disabled"), "GUI OFF must have a distinct icon and accessible status")
  await until(() => pill?.tone === undefined, "GUI indicator did not blink")
  await until(() => pill?.tone === "danger", "GUI indicator did not recover from its blink")

  for (const command of commands) command.run()
  await until(() => pill?.tone === "success", "GUI palette command did not toggle ON")

  a.state.enabled = false
  a.emit()
  await until(() => pill?.tone === "danger", "GUI did not follow an external toggle")

  setSession(b.session)
  ensure(pill?.tone === undefined, "GUI kept another server's state during a switch")
  await until(() => pill?.tone === "danger", "GUI did not follow the selected server")
  ensure(a.state.changed.size === 0 && b.state.changed.size === 1, "GUI leaked its old server subscription")
  ensure(commands.size === 1, "GUI leaked a palette command on server switch")

  b.state.problem = "Configure a provider on server B"
  b.emit()
  await until(() => diagnostics.length > 0, "GUI hid an actionable setup problem")
  ensure(pill?.tone === undefined && pill?.icon === "circle-exclamation", "Unavailable GUI status must be neutral")

  b.state.problem = undefined
  b.state.enabled = true
  b.emit()
  await until(() => pill?.tone === "success", "GUI did not recover from setup failure")

  let finishRead
  b.state.pending = new Promise((finish) => { finishRead = finish })
  const reads = b.state.reads
  b.emit()
  await until(() => b.state.reads > reads, "GUI did not start its pending read")
  setSession(a.session)
  await until(() => b.state.signal.aborted, "GUI did not abort a stale server read")
  await until(() => pill?.tone === "danger", "GUI did not restore server A's state")
  finishRead({ enabled: true })
  ensure(pill.tone === "danger", "Stale server reply overwrote GUI state")

  setSession({ ...a.session, server: { ...a.session.server, connected: false } })
  ensure(pill?.tone === undefined && pill?.run === undefined, "Disconnected GUI status must be neutral and read-only")

  setSession(undefined)
  ensure(pill === undefined, "GUI must clear its pill when the session closes")
  ensure(commands.size === 0, "GUI retained a command without an owning server")
  ensure(a.state.changed.size === 0 && b.state.changed.size === 0, "GUI retained an event subscription after session close")
  console.log("OpenCode GUI bundle sandbox smoke passed")
} finally {
  dispose()
  ensure(commands.size === 0, "GUI did not clean up its commands")
  ensure(pill === undefined, "GUI did not clean up its indicator")
}

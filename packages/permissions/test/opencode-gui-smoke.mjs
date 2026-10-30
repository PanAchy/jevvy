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
  document: { createElement: (name) => {
    ensure(name === "button", "GUI must render a native header button")
    const attributes = new Map()
    let click

    return {
      style: {},
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
      getAttribute: (key) => attributes.get(key),
      addEventListener: (event, listener) => {
        ensure(event === "click", "GUI registered an unexpected button listener")
        click = listener
      },
      click() { if (!this.disabled) click() },
    }
  } },
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

const [headerActive, setHeaderActive] = Solid.createSignal(true)

const [headerSession, setHeaderSession] = Solid.createSignal()

let indicator

let cachedIndicator

const dispose = Solid.createRoot((dispose) => {
  exports.default.setup({
    sessions: { current: session },
    toast: { show: (toast) => diagnostics.push(toast) },
    add: (token, item) => {
      if (token === gui.Command) {
        commands.add(item)
        Solid.onCleanup(() => commands.delete(item))
      } else if (token === gui.Slot) {
        ensure(item.at === "session.header", "GUI must register its indicator in the session header")
        indicator = item.render({
          get session() { return headerSession() ?? session() ?? a.session },
          get active() { return headerActive() },
        })
        cachedIndicator = item.render({ session: b.session, active: false })
        Solid.onCleanup(() => { indicator = undefined; cachedIndicator = undefined })
      } else {
        throw new Error("Unexpected GUI contribution")
      }
    },
  })

  return dispose
})

try {
  ensure(indicator.hidden && indicator.disabled, "GUI must hide its header button without a routed session")
  setSession(a.session)
  await until(() => indicator?.style.color === "#15803d", "GUI did not load ON")
  ensure(indicator.type === "button" && indicator.textContent === "Jevvy", "GUI ON must use its compact native header button")
  ensure(indicator.getAttribute("aria-pressed") === "true", "GUI ON must expose its pressed state")
  ensure(indicator.title.includes("enabled") && indicator.getAttribute("aria-label").includes("enabled"), "GUI must explain its enabled state accessibly")
  ensure(commands.size === 1, "GUI must register exactly one toggle command")
  ensure(cachedIndicator.hidden && cachedIndicator.disabled, "GUI must hide cached timeline indicators")

  setHeaderActive(false)
  ensure(indicator.hidden && indicator.disabled, "GUI must hide an inactive timeline's indicator")
  indicator.click()
  ensure(a.state.toggles === 0, "An inactive header must not toggle review")
  setHeaderActive(true)
  setHeaderSession(b.session)
  ensure(indicator.hidden && indicator.disabled, "GUI must not show another session's status")
  setHeaderSession(undefined)

  indicator.click()
  await until(() => indicator?.style.color === "#b91c1c", "GUI click did not toggle OFF")
  ensure(a.state.toggles === 1, "GUI click must persist exactly one toggle")
  ensure(indicator.getAttribute("aria-pressed") === "false" && indicator.title.includes("disabled"), "GUI OFF must expose its state accessibly")
  await until(() => indicator?.style.opacity === "0.35", "GUI indicator did not blink")
  await until(() => indicator?.style.opacity === "1", "GUI indicator did not recover from its blink")

  for (const command of commands) command.run()
  await until(() => indicator?.style.color === "#15803d", "GUI palette command did not toggle ON")

  a.state.enabled = false
  a.emit()
  await until(() => indicator?.style.color === "#b91c1c", "GUI did not follow an external toggle")

  setSession(b.session)
  ensure(indicator?.style.color === "var(--text-weak)", "GUI kept another server's state during a switch")
  await until(() => indicator?.style.color === "#b91c1c", "GUI did not follow the selected server")
  ensure(cachedIndicator.hidden && cachedIndicator.disabled, "GUI exposed a cached timeline after its session became current")
  ensure(a.state.changed.size === 0 && b.state.changed.size === 1, "GUI leaked its old server subscription")
  ensure(commands.size === 1, "GUI leaked a palette command on server switch")

  b.state.problem = "Configure a provider on server B"
  b.emit()
  await until(() => diagnostics.length > 0, "GUI hid an actionable setup problem")
  ensure(indicator?.style.color === "var(--text-weak)" && indicator?.getAttribute("aria-pressed") === undefined, "Unavailable GUI status must be neutral without a known toggle state")

  b.state.problem = undefined
  b.state.enabled = true
  b.emit()
  await until(() => indicator?.style.color === "#15803d", "GUI did not recover from setup failure")

  let finishRead
  b.state.pending = new Promise((finish) => { finishRead = finish })
  const reads = b.state.reads
  b.emit()
  await until(() => b.state.reads > reads, "GUI did not start its pending read")
  setSession(a.session)
  await until(() => b.state.signal.aborted, "GUI did not abort a stale server read")
  await until(() => indicator?.style.color === "#b91c1c", "GUI did not restore server A's state")
  finishRead({ enabled: true })
  ensure(indicator.style.color === "#b91c1c", "Stale server reply overwrote GUI state")

  setSession({ ...a.session, server: { ...a.session.server, connected: false } })
  ensure(indicator?.style.color === "var(--text-weak)" && indicator?.disabled, "Disconnected GUI status must be neutral and read-only")

  setSession(undefined)
  ensure(indicator.hidden && indicator.disabled, "GUI must hide its indicator when the session closes")
  ensure(commands.size === 0, "GUI retained a command without an owning server")
  ensure(a.state.changed.size === 0 && b.state.changed.size === 0, "GUI retained an event subscription after session close")
  console.log("OpenCode GUI bundle sandbox smoke passed")
} finally {
  dispose()
  ensure(commands.size === 0, "GUI did not clean up its commands")
  ensure(indicator === undefined && cachedIndicator === undefined, "GUI did not clean up its indicators")
}

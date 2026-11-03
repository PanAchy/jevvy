import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { join } from "node:path"

const plugin = process.env.JEVVY_PLUGIN_DIR

if (plugin === undefined || plugin.length === 0) throw new Error("JEVVY_PLUGIN_DIR is required")

export default OpenCodeDriver.use({
  keepArtifacts: true,
  tui: { recording: true },
  project: {
    git: true,
    files: {
      ".opencode/plugins/host-ask.js": `export default { id: "host-ask", async setup(ctx) {
        await ctx.permission.hook("evaluate", (event) => {
          if (event.action === "shell" && event.resources.some((r) => r.startsWith("node -p") || r.startsWith("git reset"))) event.effect = "ask"
        })
      } }`,
      "fixture.txt": "demo fixture\n",
    },
  },
  config: {
    plugins: [plugin],
    permissions: [{ action: "shell", resource: "git push *", effect: "ask" }],
  },
}, ({ ui, llm, opencode, artifacts, tui }) => Effect.gen(function*() {
  const scenario = process.env.DEMO_SCENARIO

  const commands = {
    ask: "git push origin main",
    allow: "node -p process.version && pwd",
    abstain: "git reset --hard HEAD",
  } as const

  if (scenario !== "ask" && scenario !== "allow" && scenario !== "abstain") throw new Error("DEMO_SCENARIO must be ask, allow, or abstain")

  const command = commands[scenario]

  yield* llm.queue(Llm.text(`Jevvy ${scenario}`))
  yield* llm.queue(Llm.toolCall({ index: 0, id: "call_shell", name: "shell", input: { command } }), Llm.finish("tool-calls"))

  if (scenario === "allow") yield* llm.queue(Llm.text("Done."))
  yield* ui.submit(`Run exactly this shell command: ${command}`)
  yield* ui.waitFor(command, { timeout: 20_000 })
  yield* Effect.sleep(6000)

  const plugins = yield* opencode.plugin.list({ location: { directory: join(artifacts, "files") } })
  const active = plugins.data.find((entry) => entry.id === "jevvy.permissions")

  if (active?.state.status !== "active") throw new Error(`Jevvy plugin is not active: ${JSON.stringify(active)}`)

  const frame = yield* ui.capture()
  const text = frame.lines.map((line) => line.spans.map((span) => span.text).join("").trim()).filter(Boolean).join("\n")

  console.log(text)

  if (scenario === "allow" && text.includes("Permission required")) throw new Error("eligible command prompted")

  if (scenario !== "allow" && !text.includes("Permission required")) throw new Error("human prompt missing")

  if (tui.recording === undefined) throw new Error("recording was not enabled")

  console.log("RECORDING", yield* tui.recording.finish())
}))

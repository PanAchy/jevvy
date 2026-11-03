import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scenario = process.argv[2] ?? "allow"

const headless = process.argv.includes("--headless")

const plugin = process.env.JEVVY_PLUGIN_DIR

const output = process.env.DEMO_ROOT ?? mkdtempSync(join(tmpdir(), "jevvy-claude-demo-"))

const root = join(output, `claude-${scenario}`)

const project = join(root, "project")

const home = join(root, "home")

if (plugin === undefined || plugin.length === 0) throw new Error("JEVVY_PLUGIN_DIR is required")

mkdirSync(join(project, ".claude"), { recursive: true })

mkdirSync(home, { recursive: true })

writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }))

execFileSync("git", ["init", "-q", project])

writeFileSync(join(project, "fixture.txt"), "test fixture\n")

execFileSync("git", ["-C", project, "add", "fixture.txt"])

execFileSync("git", ["-C", project, "-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "Fixture"])

const scenarios = ["ask", "allow", "abstain"]

if (!scenarios.includes(scenario)) throw new Error("scenario must be ask, allow, or abstain")

const commands = {
  ask: "git push origin main",
  allow: "node -p process.version && pwd",
  abstain: "git reset --hard HEAD",
}

const descriptions = {
  ask: "Push to origin main",
  allow: "Check Node version and working directory",
  abstain: "Reset repository to HEAD",
}

const command = commands[scenario]

const description = descriptions[scenario]

const requests = { llm: [], jev: [] }

const server = createServer(async (req, res) => {
  let text = ""

  for await (const chunk of req) text += chunk

  if (req.url?.startsWith("/v1/decisions")) {
    const body = JSON.parse(text)
    requests.jev.push(body)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "demo-mock", answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: scenario === "abstain" && key === "harmful" ? 1 : 0 }])) }))

    return
  }

  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")

    return
  }

  const body = JSON.parse(text)
  requests.llm.push({ model: body.model, result: text.includes("tool_result"), tools: (body.tools ?? []).map((tool) => tool.name) })
  const result = text.includes("tool_result")

  const events = result ? [
    ["message_start", { type: "message_start", message: { id: `msg_${scenario}_done`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ] : [
    ["message_start", { type: "message_start", message: { id: `msg_${scenario}_tool`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${scenario}`, name: "Bash", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description }) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 25 } }],
    ["message_stop", { type: "message_stop" }],
  ]

  res.writeHead(200, { "content-type": "text/event-stream" })

  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
})

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  writeFileSync(join(root, "jevvy.jsonc"), JSON.stringify({ provider: "custom", providers: { custom: { endpoint: `http://127.0.0.1:${port}/v1/decisions`, model: "demo-mock" } } }))

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: "demo-key",
    JEVVY_CONFIG: join(root, "jevvy.jsonc"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }

  const args = [
    "--model", "claude-sonnet-4-5", "--tools", "Bash", "--plugin-dir", plugin,
  ]

  if (headless) args.push("-p", "--verbose", "--no-session-persistence", "--output-format", "stream-json", "--include-hook-events", `Run exactly this Bash command: ${command}`)
  else args.push(`Run exactly this Bash command: ${command}`)
  const scriptCommand = `claude ${args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`

  const child = headless
    ? spawn("claude", args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("script", ["-qefc", scriptCommand, "/dev/null"], { cwd: project, env: { ...env, TERM: "xterm-256color", COLUMNS: "80", LINES: "28" }, detached: true, stdio: ["pipe", "pipe", "pipe"] })

  let stdout = ""
  let stderr = ""
  const chunks = []
  let recordFrom
  let themeSent = false
  let keySent = false
  let securitySent = false
  let trustSent = false

  child.stdout.on("data", (chunk) => {
    stdout += chunk

    if (!headless) chunks.push({ t: Date.now(), data: Buffer.from(chunk).toString("base64") })

    if (!headless && !themeSent && stdout.includes("Choose") && stdout.includes("text") && stdout.includes("style")) {
      themeSent = true
      setTimeout(() => child.stdin.write("\r"), 300)
    }

    if (!headless && themeSent && !keySent && stdout.includes("demo-key") && stdout.includes("confirm")) {
      keySent = true
      setTimeout(() => child.stdin.write("\x1b[A"), 300)
      setTimeout(() => child.stdin.write("\r"), 600)
    }

    if (!headless && keySent && !securitySent && stdout.includes("Security") && stdout.includes("continue")) {
      securitySent = true
      setTimeout(() => child.stdin.write("\r"), 350)
    }

    if (!headless && securitySent && !trustSent && stdout.includes("Accessing") && stdout.includes("trust")) {
      trustSent = true
      recordFrom = Date.now() + 800
      setTimeout(() => child.stdin.write("\x1b[B"), 350)
      setTimeout(() => child.stdin.write("\r"), 700)
    }
  })
  child.stderr.on("data", (chunk) => { stderr += chunk })

  const timer = setTimeout(() => {
    if (headless) child.kill("SIGTERM")
    else process.kill(-child.pid, "SIGTERM")
  }, headless ? 25_000 : 9_000)

  const status = await new Promise((resolve) => child.on("exit", resolve))

  clearTimeout(timer)

  if (!headless) {
    writeFileSync(join(output, `claude-${scenario}.ansi`), stdout)
    writeFileSync(join(output, `claude-${scenario}.json`), JSON.stringify({ recordFrom, chunks }))
  }

  const events = headless ? stdout.trim().split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line)

      return [{ type: value.type, event: value.hook_event_name ?? value.hookEventName ?? value.hook_name, message: value.message?.content, subtype: value.subtype }]
    } catch { return [] }
  }) : undefined

  console.log(JSON.stringify({
    scenario,
    status,
    command,
    themeSent,
    keySent,
    securitySent,
    trustSent,
    events,
    output: headless ? undefined : stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-2200),
    stderr: stderr.slice(-1000),
    requests,
  }, null, 2))
} finally {
  await new Promise((resolve) => server.close(resolve))

  if (process.env.DEMO_ROOT === undefined) rmSync(root, { recursive: true, force: true })
}

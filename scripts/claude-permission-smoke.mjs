import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const claude = process.env.CLAUDE_BIN ?? "claude"

const artifact = process.argv[2]

assert.ok(artifact, "Usage: CLAUDE_BIN=/path/to/claude node scripts/claude-permission-smoke.mjs packed-package.tgz")

const lab = join(root, ".agents", "lab")

mkdirSync(lab, { recursive: true })

const temporary = mkdtempSync(join(lab, "claude-permissions-"))

const version = spawnSync(claude, ["--version"], {
  encoding: "utf8", timeout: 10000,
  env: { PATH: process.env.PATH, HOME: temporary, CLAUDE_CONFIG_DIR: join(temporary, "version-config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
})

assert.equal(version.status, 0, version.stderr)

assert.equal(version.stdout.trim(), "2.1.296 (Claude Code)")

const packed = spawnSync("tar", ["-xzf", resolve(artifact), "-C", temporary], { encoding: "utf8" })

assert.equal(packed.status, 0, packed.stderr)

const plugin = join(temporary, "package")

const results = []

let succeeded = false

let current

const python = `import os,pty,sys,select,signal,fcntl,termios,struct,time
pid,fd=pty.fork()
if pid==0:
 os.chdir(sys.argv[1]);os.execvpe(sys.argv[2],sys.argv[2:],os.environ)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',45,160,0,0))
try:
 while True:
  ready,_,_=select.select([fd,sys.stdin],[],[],0.2)
  if fd in ready:
   try: data=os.read(fd,65536)
   except OSError: break
   if not data: break
   os.write(1,data)
  if sys.stdin in ready:
   data=os.read(0,65536)
   if not data: break
   os.write(fd,data)
finally:
 try: os.killpg(pid,signal.SIGTERM)
 except ProcessLookupError: pass
 time.sleep(.2)
 try: os.killpg(pid,signal.SIGKILL)
 except ProcessLookupError: pass
 os.waitpid(pid,0)
`

const sendMessage = (response, body, content, stopReason) => {
  const message = {
    id: "msg_fixture", type: "message", role: "assistant", model: body.model,
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }

  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(message))

    return
  }

  response.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit("message_start", { message: { ...message, content: [], stop_reason: null } })

  for (const [index, block] of content.entries()) {
    const tool = block.type === "tool_use"
    emit("content_block_start", { index, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } })
    emit("content_block_delta", { index, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text } })
    emit("content_block_stop", { index })
  }

  emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
  emit("message_stop", {})
  response.end()
}

const server = createServer(async (request, response) => {
  try {
    const chunks = []

    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())

    if (request.url === "/decisions") {
      assert.equal(request.headers.authorization, undefined)
      current.judgments.push(body)
      response.writeHead(current.answer === "failure" ? 503 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(current.answer === "failure" ? { error: "fixture unavailable" } : {
        model: body.model,
        answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: current.answer === "ask" ? 1 : 0 }])),
      }))
    } else if (request.url === "/observe") {
      current.events.push(body)
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
    } else if (request.url.startsWith("/v1/messages")) {
      assert.equal(request.headers["x-api-key"], "sk-ant-jevvy-fixture-only")
      current.chat.push(body)

      const toolResults = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((block) => block.type === "tool_result" && block.tool_use_id === "tool_fixture")

      current.toolResults.push(...toolResults)
      const main = body.tools?.some((tool) => tool.name === "Bash")
      const tool = main && !current.sent && toolResults.length === 0

      if (tool) current.sent = true
      sendMessage(response, body, tool
        ? [{ type: "tool_use", id: "tool_fixture", name: "Bash", input: { command: current.command, description: "Execute harmless local permission fixture" } }]
        : [{ type: "text", text: "Fixture turn complete." }], tool ? "tool_use" : "end_turn")
    } else {
      current.unexpected.push(request.url)
      response.writeHead(404)
      response.end("{}")
    }
  } catch (error) {
    current.errors.push(String(error))
    response.writeHead(500)
    response.end("{}")
  }
})

await new Promise((ready) => server.listen(0, "127.0.0.1", ready))

const endpoint = `http://127.0.0.1:${server.address().port}`

const run = async (name, options = {}) => {
  const directory = join(temporary, name)
  const project = join(directory, "project")
  const home = join(directory, "home")
  const config = join(home, ".claude")
  const xdg = join(home, ".config")
  mkdirSync(project, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(join(xdg, "jevvy"), { recursive: true })
  const git = spawnSync("git", ["init", "--quiet", project])
  assert.equal(git.status, 0)
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }))
  const ask = options.ask ?? ["Bash(echo jevvy-*)"]

  const settings = {
    permissions: { ask, allow: options.allow ?? [], deny: options.deny ?? [], defaultMode: "manual" },
    hooks: Object.fromEntries(["PermissionRequest", "PostToolUse", "PostToolUseFailure"].map((event) => [event, [{ matcher: "Bash", hooks: [{ type: "http", url: `${endpoint}/observe` }] }]])),
  }

  const settingsPath = join(config, "settings.json")
  writeFileSync(settingsPath, JSON.stringify(settings))
  const jevvyPath = join(xdg, "jevvy", "jevvy.jsonc")
  writeFileSync(jevvyPath, JSON.stringify({
    provider: "custom", providers: { custom: { endpoint: `${endpoint}/decisions`, model: "fixture" } },
    permissions: { timeoutMs: 2000, claude: { enabled: options.enabled ?? true }, reviewAskPatterns: options.nominations ?? { claude: ["Bash(echo jevvy-*)"] } },
  }))
  const command = options.command ?? `echo jevvy-${name}`
  current = { command, answer: options.answer ?? "allow", judgments: [], events: [], chat: [], toolResults: [], errors: [], unexpected: [], sent: false }
  const state = current

  const environment = {
    PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: xdg,
    TERM: "xterm-256color", LANG: "C.UTF-8", ANTHROPIC_API_KEY: "sk-ant-jevvy-fixture-only",
    ANTHROPIC_BASE_URL: endpoint, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    TMPDIR: directory,
  }

  const child = spawn("python3", ["-u", "-c", python, project, claude, "Run the local permission fixture.",
    "--model", "claude-sonnet-4-6", "--permission-mode", "manual", "--debug-file", join(directory, "debug.log"),
    "--ax-screen-reader", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--plugin-dir", plugin,
  ], { env: environment, stdio: ["pipe", "pipe", "pipe"] })

  let transcript = ""
  let stderr = ""
  let exited = false
  let trusted = false
  let acceptedKey = false
  const timers = new Set()

  const later = (action, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer)

      if (!exited) action()
    }, delay)

    timers.add(timer)
  }

  const yes = () => later(() => {
    child.stdin.write("y")
    later(() => child.stdin.write("\r"), 100)
  }, 150)

  child.stdout.on("data", (data) => {
    transcript += data.toString()

    if (!trusted && /Yes, I trust this folder[\s\S]*Enter y\/n:/.test(transcript)) {
      trusted = true
      yes()
    }

    if (!acceptedKey && /Do you want to use this API key\?[\s\S]*Enter y\/n:/.test(transcript)) {
      acceptedKey = true
      yes()
    }
  })
  child.stderr.on("data", (data) => { stderr += data.toString() })

  const completion = new Promise((done) => child.on("exit", (code, signal) => {
    exited = true
    done({ code, signal })
  }))

  const hookFinished = `Hooks: PermissionRequest:Bash [node ${plugin}/dist/claude-hook.js] (plugin jevvy-permissions@inline) finished with status 0`

  const hookSettled = () => existsSync(join(directory, "debug.log")) && readFileSync(join(directory, "debug.log"), "utf8").includes(hookFinished)

  const pending = () => transcript.lastIndexOf("Do you want to proceed?") > Math.max(
    transcript.lastIndexOf("Allowed by PermissionRequest hook"),
    transcript.lastIndexOf("Fixture turn complete."),
    transcript.lastIndexOf("tool error: Bash"),
  )

  try {
    const deadline = Date.now() + 30000

    while (Date.now() < deadline) {
      if (options.outcome === "prompt" ? pending() && hookSettled() : state.toolResults.length > 0 && transcript.includes("Fixture turn complete.")) break
      assert.equal(exited, false, `Claude exited early: ${transcript}\n${stderr}`)
      await new Promise((ready) => setTimeout(ready, 50))
    }

    assert.equal(state.errors.length, 0, JSON.stringify(state.errors))
    assert.equal(state.unexpected.length, 0, JSON.stringify(state.unexpected))
    assert.equal(state.sent, true, `No real Bash tool use emitted: ${transcript}`)

    if (options.outcome === "prompt") {
      assert.equal(pending(), true, `No native permission prompt: ${transcript}`)
      assert.equal(state.events.filter((event) => event.hook_event_name === "PostToolUse").length, 0)
      assert.equal(state.toolResults.length, 0)
    } else if (options.outcome === "deny") {
      assert.equal(state.events.filter((event) => event.hook_event_name === "PostToolUse").length, 0)
      assert.ok(state.toolResults.some((result) => result.is_error), JSON.stringify(state.toolResults))
      assert.equal(pending(), false)
    } else {
      const executed = state.events.find((event) => event.hook_event_name === "PostToolUse" && event.tool_input.command === command)

      assert.ok(executed, `Real Bash must complete: ${transcript}`)
      assert.equal(executed.tool_response.stdout.trim(), options.output ?? `jevvy-${name}`)
      assert.equal(pending(), false, "No human permission approval may be sent")
      assert.ok(state.toolResults.some((result) => !result.is_error))
    }

    const expectedCalls = options.calls ?? 1
    assert.equal(state.judgments.length, expectedCalls, JSON.stringify(state.judgments))

    for (const judgment of state.judgments) {
      assert.deepEqual(judgment.state, { action: "shell", resource: command })
      assert.ok(Object.keys(judgment.questions).length > 0)
    }

    if (expectedCalls > 0 && options.outcome === undefined) assert.ok(transcript.includes("Allowed by PermissionRequest hook"))

    const requests = state.events.filter((event) => event.hook_event_name === "PermissionRequest")
    assert.equal(requests.length, options.permissionEvents ?? 1)

    for (const event of requests) assert.equal(event.tool_input.command, command)
    const debug = readFileSync(join(directory, "debug.log"), "utf8")

    assert.ok(debug.includes("Read hooks.json for plugin jevvy-permissions (enabled=true)"))
    assert.equal(debug.includes(hookFinished), requests.length > 0)
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), settings, "No durable global approval rule")
    assert.equal(existsSync(join(project, ".claude", "settings.local.json")), false, "No durable project approval rule")
    const persisted = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8"))

    assert.deepEqual(persisted.projects[project].allowedTools, [], "No legacy durable project approval rule")

    if (options.outcome === "prompt") {
      const beforeCancellation = transcript.length

      child.stdin.write("\u001b")
      const deadline = Date.now() + 5000

      while (Date.now() < deadline && !transcript.slice(beforeCancellation).includes("What should Claude do instead?")) await new Promise((ready) => setTimeout(ready, 50))
      assert.ok(transcript.slice(beforeCancellation).includes(`tool error: Bash (${command})`), "The native permission prompt must cancel this Bash call")
      assert.ok(transcript.slice(beforeCancellation).includes("Interrupted  · What should Claude do instead?"))
      assert.equal(pending(), false)
      assert.equal(state.toolResults.some((result) => !result.is_error), false)
      assert.equal(state.events.filter((event) => event.hook_event_name === "PostToolUse").length, 0)
      assert.equal(existsSync(join(project, "marker.txt")), false)
      state.cancelled = true
    }

    results.push({ name, status: "PASS", outcome: options.outcome ?? "execute", judgments: state.judgments.length, permissionEvents: requests.length, command })
    console.log(`PASS ${name}: ${options.outcome ?? "execute"}, Jev HTTP=${state.judgments.length}, native PermissionRequest=${requests.length}`)
  } catch (error) {
    results.push({ name, status: "FAIL", error: String(error) })

    throw error
  } finally {
    for (const timer of timers) clearTimeout(timer)
    child.stdin.end()
    const teardown = setTimeout(() => child.kill("SIGKILL"), 3000)
    await completion
    clearTimeout(teardown)
    writeFileSync(join(directory, "terminal.txt"), transcript)
    writeFileSync(join(directory, "observations.json"), JSON.stringify({ ...state, chat: state.chat.map((body) => ({ model: body.model, stream: body.stream })) }, null, 2))
  }
}

try {
  await run("nominated")
  await run("unlisted", { nominations: {}, outcome: "prompt", calls: 0 })
  await run("opencode-only", { nominations: { opencode: ["Bash(echo jevvy-*)"] }, outcome: "prompt", calls: 0 })
  await run("nonexact-nomination", { nominations: { claude: ["Bash(echo *)"] }, outcome: "prompt", calls: 0 })
  await run("overlap-first", { ask: ["Bash(echo *)", "Bash(echo jevvy-*)"], outcome: "prompt", calls: 0 })
  await run("overlap-last", { ask: ["Bash(echo jevvy-*)", "Bash(echo *)"], outcome: "prompt", calls: 0 })
  await run("jev-ask", { answer: "ask", outcome: "prompt" })
  await run("jev-failure", { answer: "failure", outcome: "prompt" })
  await run("disabled", { enabled: false, outcome: "prompt", calls: 0 })
  await run("native-allow", { ask: [], allow: ["Bash(echo jevvy-*)"], calls: 0, permissionEvents: 0 })
  await run("native-deny", { ask: [], deny: ["Bash(echo jevvy-*)"], outcome: "deny", calls: 0, permissionEvents: 0 })
  await run("compound", { command: "echo jevvy-compound && echo jevvy-second", output: "jevvy-compound\njevvy-second" })
  await run("baseline-bash", { ask: ["Bash"], nominations: {} })
  await run("baseline-bash-star", { ask: ["Bash(*)"], nominations: {} })
  await run("redirect-uncertainty", { command: "echo jevvy-redirect-uncertainty > marker.txt", outcome: "prompt", calls: 0 })
  succeeded = true
  console.log(`Claude Code 2.1.296 real-host permission smoke passed (${results.length} cases; localhost fake chat and judgment providers).`)
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  writeFileSync(join(temporary, "results.json"), JSON.stringify(results, null, 2))
  console.log(`Evidence: ${temporary}`)

  if (process.env.JEVVY_SMOKE_KEEP !== "1" && succeeded) rmSync(temporary, { recursive: true, force: true })
}

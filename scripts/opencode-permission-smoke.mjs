import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"

export const withPermissionSmoke = async (project, runHost, record = () => undefined) => {
  const judgments = []
  let nextCommand
  let answer = "allow"
  let sequence = 0

  const provider = createServer(async (request, response) => {
    const chunks = []

    for await (const chunk of request) chunks.push(chunk)

    const body = JSON.parse(Buffer.concat(chunks).toString())

    if (request.url === "/v1/decisions") {
      judgments.push(body)

      if (answer === "timeout") return

      if (answer === "failure") {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "Smoke provider unavailable" } }))

        return
      }

      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        model: body.model,
        answers: answer === "malformed" ? {} : Object.fromEntries(
          Object.keys(body.questions).map((key) => [key, { type: "noul", noul: answer === "ask" || answer === `inquiry:${key}` ? 1 : 0 }]),
        ),
      }))

      return
    }

    assert.equal(request.url, "/v1/chat/completions")

    const command = body.tools?.length ? nextCommand : undefined

    if (command !== undefined) nextCommand = undefined

    const message = command === undefined
      ? { role: "assistant", content: "Smoke finished." }
      : {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: command.id,
            type: "function",
            function: { name: "shell", arguments: JSON.stringify({ command: command.text }) },
          }],
        }

    const finishReason = command === undefined ? "stop" : "tool_calls"

    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "smoke",
        object: "chat.completion",
        model: "smoke",
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))

      return
    }

    const delta = command === undefined
      ? message
      : { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] }

    response.writeHead(200, { "content-type": "text/event-stream" })

    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: finishReason },
    ]) {
      response.write(`data: ${JSON.stringify({
        id: "smoke",
        object: "chat.completion.chunk",
        model: "smoke",
        choices: [choice],
      })}\n\n`)
    }

    response.end("data: [DONE]\n\n")
  })

  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))

  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`

  const config = {
    plugins: ["@jevvy/permissions"],
    model: "smoke/smoke",
    providers: {
      smoke: {
        env: ["JEVVY_SMOKE_MODEL_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: endpoint, apiKey: "credential-free-smoke" },
        models: { smoke: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 4000 } } },
      },
    },
    permissions: [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "echo jevvy-human *", effect: "ask" },
      { action: "shell", resource: "echo jevvy-allowed *", effect: "allow" },
      { action: "shell", resource: "echo jevvy-denied *", effect: "deny" },
    ],
    agents: { build: { permissions: [{ action: "shell", resource: "echo jevvy-agent-human *", effect: "ask" }] } },
  }

  writeFileSync(join(project, "opencode.jsonc"), `${JSON.stringify(config, null, 2)}\n`)

  const defaultProject = join(project, "..", "default-policy")

  mkdirSync(defaultProject, { recursive: true })
  writeFileSync(join(defaultProject, "opencode.jsonc"), `${JSON.stringify({ ...config, permissions: [] }, null, 2)}\n`)

  const nominationProject = join(project, "..", "nomination-policy")

  mkdirSync(nominationProject, { recursive: true })
  writeFileSync(join(nominationProject, "opencode.jsonc"), `${JSON.stringify({
    ...config,
    permissions: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "shell", resource: "echo jevvy-nominated *", effect: "ask" },
      { action: "shell", resource: "echo jevvy-unlisted *", effect: "ask" },
      { action: "shell", resource: "echo jevvy-native-allow *", effect: "allow" },
      { action: "shell", resource: "echo jevvy-native-deny *", effect: "deny" },
    ],
    agents: { build: { permissions: [
      { action: "shell", resource: "echo jevvy-agent-nominated *", effect: "ask" },
      { action: "shell", resource: "echo jevvy-agent-unlisted *", effect: "ask" },
    ] } },
  }, null, 2)}\n`)

  const exercise = async (api, nominations) => {
    const createSession = async (directory = project, permissions = []) => {
      const session = await api("POST", "/api/session", {
        title: "Shell review smoke",
        location: { directory },
        agent: "build",
        model: { providerID: "smoke", id: "smoke" },
        permissions,
      })

      for (let attempt = 0; attempt < 120; attempt++) {
        const query = `location[directory]=${encodeURIComponent(directory)}`

        const [plugins, models] = await Promise.all([
          api("GET", `/api/plugin?${query}`),
          api("GET", `/api/model?${query}`),
        ])

        const plugin = plugins.data.find((entry) => entry.id === "jevvy.permissions")
        const modelReady = models.data.some((model) => model.providerID === "smoke" && model.id === "smoke")

        if (plugin?.state.status === "active" && modelReady) {
          console.log(`jevvy.permissions active: ${nominations?.name ?? "baseline"} at ${directory}`)
          break
        }

        assert.notEqual(plugin?.state.status, "failed", JSON.stringify(plugin))

        if (attempt === 119) throw new Error(`Jevvy and the fake model did not activate at ${directory}: ${JSON.stringify({ plugins, models })}`)

        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      return session.data.id
    }

    const waitForOutcome = async (sessionID, callID) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const pending = await api("GET", `/api/session/${sessionID}/permission`)
        const context = await api("GET", `/api/session/${sessionID}/context`)

        const parts = context.data.flatMap((message) => message.type === "assistant" ? message.content : [])
        const shell = parts.find((part) => part.type === "tool" && part.id === callID)

        if (pending.data.length > 0 || shell?.state.status === "completed" || shell?.state.status === "error") {
          return { pending: pending.data, shell }
        }

        const failure = context.data.find((message) => message.type === "assistant" && message.error !== undefined)

        assert.equal(failure, undefined, JSON.stringify(context))
        assert.ok(!context.data.some((message) => message.type === "idle" && message.outcome === "failed"), JSON.stringify(context))

        if (attempt === 199) throw new Error(`shell did not settle or prompt: ${JSON.stringify(context)}`)

        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    const run = async (sessionID, command) => {
      const callID = `call_smoke_shell_${++sequence}`

      nextCommand = { text: command, id: callID }
      await api("POST", `/api/session/${sessionID}/prompt`, { text: "Run the smoke command." })

      return { ...await waitForOutcome(sessionID, callID), callID, sessionID }
    }

    const assertExecuted = (outcome, output) => {
      assert.deepEqual(outcome.pending, [], "Jev approval must not leave a manual prompt")
      assert.equal(outcome.shell?.state.status, "completed", JSON.stringify(outcome))
      assert.ok(outcome.shell.state.content.some((part) => part.type === "text" && part.text.includes(output)), "the real shell must execute")
    }

    if (nominations !== undefined) {
      const delegatedCatchAll = nominations.name === "catchall" || nominations.name === "specific"
      const delegatedSpecific = nominations.name === "specific"
      const inquiryNames = ["harmful", "obscured", "sensitive", "untrusted"]

      const scenarios = [
        { name: "project wildcard-action catchall", command: "echo jevvy-wildcard nominated", delegated: delegatedCatchAll },
        { name: "project specific ask", command: "echo jevvy-nominated project", delegated: delegatedSpecific },
        { name: "agent specific ask", command: "echo jevvy-agent-nominated agent", delegated: delegatedSpecific },
        { name: "session specific ask", command: "echo jevvy-session-nominated session", rules: [{ action: "shell", resource: "echo jevvy-session-nominated *", effect: "ask" }], delegated: delegatedSpecific },
        { name: "unlisted winning project ask", command: "echo jevvy-unlisted project", delegated: false },
        { name: "unlisted winning agent ask", command: "echo jevvy-agent-unlisted agent", delegated: false },
        { name: "unlisted winning session ask", command: "echo jevvy-session-unlisted session", rules: [{ action: "shell", resource: "echo jevvy-session-unlisted *", effect: "ask" }], delegated: false },
        { name: "later session catchall overrides agent ask", command: "echo jevvy-agent-unlisted overridden", rules: [{ action: "*", resource: "*", effect: "ask" }], delegated: delegatedCatchAll },
        { name: "compound nominated resources", command: "echo jevvy-nominated compound && echo jevvy-agent-nominated complete", delegated: delegatedSpecific },
        { name: "compound unlisted resource", command: "echo jevvy-nominated mixed && echo jevvy-unlisted retained", delegated: false },
        { name: "native final allow", command: "echo jevvy-native-allow finalized", native: "allow", delegated: false },
        { name: "native final deny", command: "echo jevvy-native-deny finalized", native: "deny", delegated: false },
      ]

      if (delegatedSpecific) {
        for (const inquiry of inquiryNames) {
          scenarios.push({ name: `compound inquiry ${inquiry} abstains`, command: `echo jevvy-nominated ${inquiry} && echo jevvy-agent-nominated ${inquiry}`, delegated: true, inquiry })
        }
      }

      for (const scenario of scenarios) {
        answer = scenario.inquiry === undefined ? "allow" : `inquiry:${scenario.inquiry}`
        const before = judgments.length
        const sessionID = await createSession(nominationProject, scenario.rules ?? [])
        const outcome = await run(sessionID, scenario.command)

        assert.equal(judgments.length, before + Number(scenario.delegated), `${nominations.name}: ${scenario.name}: provider call count`)

        if (scenario.delegated) {
          assert.deepEqual(judgments.at(-1).state, { action: "shell", resource: scenario.command }, "every inquiry must see the complete command in the shared state")
          assert.deepEqual(Object.keys(judgments.at(-1).questions).sort(), inquiryNames, "all shipped inquiries must participate")
        }

        if (scenario.native === "deny") {
          assert.deepEqual(outcome.pending, [])
          assert.equal(outcome.shell?.state.status, "error", "native deny must prevent actual execution")
        } else if (scenario.native === "allow" || (scenario.delegated && scenario.inquiry === undefined)) {
          assertExecuted(outcome, scenario.command.split(" && ").at(-1).slice("echo ".length))
        } else {
          assert.equal(outcome.pending.length, 1, `${nominations.name}: ${scenario.name} must retain a native prompt`)
          assert.equal(outcome.pending[0].action, "shell")
          assert.equal(outcome.shell?.state.status, "running", "the real shell must not execute before host approval")
          await api("POST", `/api/session/${sessionID}/permission/${outcome.pending[0].id}/reply`, { decision: "reject" })
          const rejected = await waitForOutcome(sessionID, outcome.callID)
          assert.deepEqual(rejected.pending, [])
          assert.equal(rejected.shell?.state.status, "error", "rejecting a pending native prompt must prevent execution")
        }

        await api("POST", `/api/experimental/session/${sessionID}/wait`)
        assert.deepEqual((await api("GET", "/api/permission/saved")).data, [], "nomination must never save a durable rule")

        if (scenario.native === undefined) record({ command: scenario.command, mode: scenario.delegated ? scenario.inquiry === undefined ? "allow" : `inquiry:${scenario.inquiry}` : "explicit-ask", questions: inquiryNames })
        console.log(`nomination ${nominations.name}: ${scenario.name}: passed (${judgments.length - before} Jev HTTP requests)`)
      }

      answer = "allow"

      return
    }

    const sessionID = await createSession()
    const first = await run(sessionID, "echo jevvy-reviewed")

    assert.equal(judgments.length, 1, `a real shell call must reach Jev, not merely complete\n${JSON.stringify(first)}`)
    assert.deepEqual(judgments[0].state, { action: "shell", resource: "echo jevvy-reviewed" })
    assertExecuted(first, "jevvy-reviewed")
    await api("POST", `/api/experimental/session/${sessionID}/wait`)
    record({ command: "echo jevvy-reviewed", mode: "allow", questions: Object.keys(judgments[0].questions) })

    const compound = await run(sessionID, "echo jevvy-compound && echo second-command")

    assertExecuted(compound, "second-command")
    assert.equal(judgments.length, 2)
    assert.deepEqual(judgments[1].state, { action: "shell", resource: "echo jevvy-compound && echo second-command" })
    await api("POST", `/api/experimental/session/${sessionID}/wait`)
    record({ command: "echo jevvy-compound && echo second-command", mode: "allow", questions: Object.keys(judgments[1].questions) })

    const saved = await api("GET", "/api/permission/saved")

    assert.deepEqual(saved.data, [], "Jev approvals must not create durable rules")

    const noBaseline = await run(await createSession(defaultProject), "echo jevvy-default")

    assertExecuted(noBaseline, "jevvy-default")
    assert.equal(judgments.length, 2, "default allows must not call Jev")
    await api("POST", `/api/experimental/session/${noBaseline.sessionID}/wait`)

    const allowed = await run(await createSession(), "echo jevvy-allowed exception")

    assertExecuted(allowed, "jevvy-allowed exception")
    assert.equal(judgments.length, 2, "configured allows must not call Jev")
    await api("POST", `/api/experimental/session/${allowed.sessionID}/wait`)

    const denied = await run(await createSession(), "echo jevvy-denied exception")

    assert.deepEqual(denied.pending, [])
    assert.equal(denied.shell?.state.status, "error", "configured deny must prevent execution")
    assert.equal(judgments.length, 2, "configured denies must not call Jev")
    await api("POST", `/api/experimental/session/${denied.sessionID}/wait`)

    for (const [command, rules] of [
      ["echo jevvy-human exception", []],
      ["echo first-command && echo jevvy-human compound", []],
      ["echo jevvy-agent-human exception", []],
      ["echo jevvy-session-human", [{ action: "shell", resource: "echo jevvy-session-human", effect: "ask" }]],
      ["echo jevvy-wildcard-human", [{ action: "*", resource: "*", effect: "ask" }]],
    ]) {
      const humanSession = await createSession(project, rules)
      const outcome = await run(humanSession, command)

      assert.equal(outcome.pending.length, 1, "specific and wildcard-action asks must stay human-only")
      assert.equal(outcome.pending[0].action, "shell")
      assert.equal(outcome.shell?.state.status, "running", "a prompt must precede shell execution")
      assert.equal(judgments.length, 2, "human-only asks must not call Jev")
      await api("POST", `/api/session/${humanSession}/permission/${outcome.pending[0].id}/reply`, { decision: "reject" })
      await api("POST", `/api/experimental/session/${humanSession}/wait`)
      record({ command, mode: "explicit-ask" })
    }

    for (const mode of ["ask", "failure", "malformed", "timeout"]) {
      answer = mode

      const fallbackSession = await createSession()
      const command = `echo jevvy-fallback-${mode}`
      const before = judgments.length
      const outcome = await run(fallbackSession, command)

      assert.equal(judgments.length, before + 1)
      assert.deepEqual(judgments.at(-1).state, { action: "shell", resource: command })
      assert.equal(outcome.pending.length, 1, `${mode} must retain a manual prompt`)
      assert.equal(outcome.pending[0].action, "shell")
      assert.equal(outcome.shell?.state.status, "running", "abstention must not execute the command")
      await api("POST", `/api/session/${fallbackSession}/permission/${outcome.pending[0].id}/reply`, { decision: "once" })

      assertExecuted(await waitForOutcome(fallbackSession, outcome.callID), `jevvy-fallback-${mode}`)
      await api("POST", `/api/experimental/session/${fallbackSession}/wait`)
      record({ command, mode, questions: Object.keys(judgments.at(-1).questions) })
    }

    assert.deepEqual((await api("GET", "/api/permission/saved")).data, [], "all approvals must remain one-action")
    const controlPath = `/api/rpc/jevvy.permissions.control/toggle?location[directory]=${encodeURIComponent(project)}`
    assert.equal((await api("POST", controlPath, {})).output.enabled, false)
    const pausedSession = await createSession()
    const beforePause = judgments.length
    const paused = await run(pausedSession, "echo jevvy-reviewed")
    assert.equal(paused.pending.length, 1, "OFF must leave even cached approvals to the host")
    assert.equal(judgments.length, beforePause, "OFF must not call Jev")
    await api("POST", `/api/session/${pausedSession}/permission/${paused.pending[0].id}/reply`, { decision: "reject" })
    await api("POST", `/api/experimental/session/${pausedSession}/wait`)
    assert.equal((await api("POST", controlPath, {})).output.enabled, true)
    answer = "allow"
    const resumedSession = await createSession()
    const resumed = await run(resumedSession, "echo jevvy-reviewed")
    assertExecuted(resumed, "jevvy-reviewed")
    assert.equal(judgments.length, beforePause, "ON must reuse valid process-lifetime cached judgments")
    await api("POST", `/api/experimental/session/${resumedSession}/wait`)
    record({ command: "echo jevvy-reviewed", mode: "allow", questions: Object.keys(judgments[0].questions) })
  }

  try {
    await runHost(`${endpoint}/decisions`, exercise)

    for (const nominations of [
      { name: "absent" },
      { name: "empty", patterns: { opencode: [], claude: [] } },
      { name: "claude-only", patterns: { claude: ["*", "echo jevvy-nominated *", "echo jevvy-agent-nominated *", "echo jevvy-session-nominated *"] } },
      { name: "catchall", patterns: { opencode: ["*"] } },
      { name: "specific", patterns: { opencode: ["*", "echo jevvy-nominated *", "echo jevvy-agent-nominated *", "echo jevvy-session-nominated *"] } },
    ]) {
      await runHost(`${endpoint}/decisions`, (api) => exercise(api, nominations), nominations.patterns)
    }
  } finally {
    provider.closeAllConnections()
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
  }
}

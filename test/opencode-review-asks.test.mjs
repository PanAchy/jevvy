import { afterEach, describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import plugin from "../packages/permissions/src/opencode/index.ts"

const catchAll = { action: "*", resource: "*", effect: "ask" }

const specific = { action: "shell", resource: "npm run *", effect: "ask" }

const command = "pwd && npm run build > build.log"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("OpenCode nominated ask rules", () => {
  it.effect.each([
    { name: "absent list", expectedEffect: "ask", calls: 0 },
    { name: "empty list", patterns: [], expectedEffect: "ask", calls: 0 },
    { name: "Claude-only nominations", claudePatterns: ["*", "npm run *"], expectedEffect: "ask", calls: 0 },
    { name: "generic delegation", patterns: ["*"], expectedEffect: "allow", calls: 1 },
    { name: "unlisted agent ask", patterns: ["*"], agentRules: [catchAll, specific], expectedEffect: "ask", calls: 0 },
    { name: "specific delegation", patterns: ["*", "npm run *"], agentRules: [catchAll, specific], expectedEffect: "allow", calls: 1 },
    { name: "unlisted session ask", patterns: ["*"], sessionRules: [specific], expectedEffect: "ask", calls: 0 },
    { name: "later delegated session gate", patterns: ["*"], agentRules: [catchAll, specific], sessionRules: [catchAll], expectedEffect: "allow", calls: 1 },
    { name: "existing shell invitation", agentRules: [{ action: "shell", resource: "*", effect: "ask" }], expectedEffect: "allow", calls: 1 },
    { name: "non-shell ask", patterns: ["*"], action: "edit", expectedEffect: "ask", calls: 0 },
    { name: "final host allow", patterns: ["*"], initial: "allow", expectedEffect: "allow", calls: 0 },
    { name: "final host deny", patterns: ["*"], initial: "deny", expectedEffect: "deny", calls: 0 },
    { name: "review abstention", patterns: ["*"], score: 1, expectedEffect: "ask", calls: 1 },
    { name: "toggle OFF", patterns: ["*"], enabled: false, expectedEffect: "ask", calls: 0 },
  ])("preserves $name through plugin setup and evaluation", (scenario) => Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(), "jevvy-review-asks-"))),
    (directory) => Effect.gen(function*() {
      vi.spyOn(console, "info").mockImplementation(() => {})
      vi.spyOn(console, "warn").mockImplementation(() => {})

      const path = join(directory, "jevvy.jsonc")

      yield* Effect.promise(() => writeFile(path, JSON.stringify({
        provider: "custom",
        providers: { custom: { endpoint: "http://127.0.0.1:1/systemone", model: "fixture-model" } },
        permissions: { reviewAskPatterns: { opencode: scenario.patterns, claude: scenario.claudePatterns }, opencode: { enabled: scenario.enabled ?? true } },
      }), { mode: 0o600 }))

      vi.stubEnv("JEVVY_CONFIG", path)

      const hooks = new Map()
      const hook = (name, handler) => Effect.sync(() => { hooks.set(name, handler) })
      const session = vi.fn(() => Effect.succeed({ agent: "build", location: { directory }, permissions: scenario.sessionRules ?? [] }))
      const agent = vi.fn(() => Effect.succeed({ data: { permissions: scenario.agentRules ?? [catchAll] } }))

      const transport = vi.fn((_url, input) => {
        const body = JSON.parse(input.body)
        const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: scenario.score ?? 0 }]))

        return Promise.resolve(Response.json({ model: "fixture-model", answers }))
      })

      yield* plugin.effect({
        rpc: { register: () => Effect.succeed({}) },
        command: { transform: () => Effect.void },
        tool: { hook },
        shell: { hook },
        permission: { hook },
        session: { get: session },
        agent: { get: agent },
      })

      yield* hooks.get("execute.before")({ tool: "shell", sessionID: "ses_fixture", messageID: "msg_fixture", id: "call_fixture", input: { command } })
      yield* hooks.get("create.before")({ command, cwd: directory, timeout: 1000, shell: "/bin/bash", env: {} })

      const initial = {
        sessionID: "ses_fixture",
        agent: "review-agent",
        action: scenario.action ?? "shell",
        resources: ["pwd", "npm run build"],
        effect: scenario.initial ?? "ask",
        message: "original host message",
        source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" },
      }

      const event = { ...initial }

      yield* hooks.get("evaluate")(event).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

      expect(event).toEqual({ ...initial, effect: scenario.expectedEffect })
      expect(transport).toHaveBeenCalledTimes(scenario.calls)

      if (scenario.calls > 0) {
        expect(JSON.parse(transport.mock.calls[0][1].body).state).toEqual({ action: "shell", resource: command })
        expect(session).toHaveBeenCalledExactlyOnceWith({ sessionID: "ses_fixture" })
        expect(agent).toHaveBeenCalledExactlyOnceWith({ agentID: "review-agent", location: { directory } })
      }
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ))
})

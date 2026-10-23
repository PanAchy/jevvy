import { afterEach, describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Deferred from "effect/Deferred"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as TestClock from "effect/testing/TestClock"
import { loadJevvyConfig } from "../packages/permissions/src/config.ts"
import plugin from "../packages/permissions/src/opencode/index.ts"
import { acquireClaudeReviewer, createClaudeHookHandler, loadClaudeConfiguration } from "../packages/permissions/src/claude/hook.ts"
import { permissionAllowOutput } from "../packages/permissions/src/claude/evaluate.ts"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const questions = { harmful: {
  type: "noul", instructions: "Could this cause harm?", criteria: { false: "Harmless", true: "Harmful" }, threshold: 0.2,
} }

const openCodeReview = Effect.fn("Test.openCodeReview")(function*() {
  const hooks = new Map()
  const hook = (name, handler) => Effect.sync(() => { hooks.set(name, handler) })

  yield* plugin.effect({
    rpc: { register: () => Effect.succeed({}) },
    command: { transform: () => Effect.void },
    tool: { hook },
    shell: { hook },
    permission: { hook },
    session: { get: () => Effect.succeed({ agent: "build", location: { directory: "/workspace" } }) },
    agent: { get: () => Effect.succeed({ data: { permissions: [] } }) },
  })

  yield* hooks.get("execute.before")({
    tool: "shell", sessionID: "ses_test", messageID: "msg_test", id: "call_test", input: { command: "pwd" },
  })
  yield* hooks.get("create.before")({ command: "pwd", cwd: "/workspace", timeout: 1000, shell: "/bin/bash", env: {} })

  const event = {
    sessionID: "ses_test", action: "shell", resources: ["pwd"], effect: "ask",
    source: { type: "tool", messageID: "msg_test", id: "call_test" },
  }

  yield* hooks.get("evaluate")(event)

  return event.effect === "allow"
})

const claudeReview = Effect.fn("Test.claudeReview")(function*() {
  const handler = createClaudeHookHandler(loadClaudeConfiguration, acquireClaudeReviewer, () => Effect.succeed(["Bash"]))

  const output = yield* handler(JSON.stringify({
    session_id: "ses_test", prompt_id: "prompt_test", transcript_path: "/unused/transcript", cwd: "/workspace",
    permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "pwd" },
  }))

  expect(output).toBeOneOf([undefined, permissionAllowOutput])

  return output !== undefined
})

describe.each([
  { harness: "opencode", provider: "custom" }, { harness: "claude", provider: "custom" },
  { harness: "opencode", provider: "zen" }, { harness: "claude", provider: "zen" },
])("$harness configured timeout with $provider", ({ harness, provider }) => {
  it.effect.each([
    { kind: "shipped-policy", timeoutMs: undefined }, { kind: "shipped-policy", timeoutMs: 12_000 },
    { kind: "custom-policy", timeoutMs: undefined }, { kind: "custom-policy", timeoutMs: 12_000 },
  ])("uses $kind timeoutMs $timeoutMs for a slow provider", ({ kind, timeoutMs }) => Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "jevvy-timeout-"))),
    (directory) => Effect.gen(function*() {
      vi.spyOn(console, "info").mockImplementation(() => {})
      vi.spyOn(console, "warn").mockImplementation(() => {})

      const path = join(directory, "jevvy.jsonc")
      const permissions = { timeoutMs }

      if (kind === "custom-policy") permissions.questions = questions

      yield* Effect.promise(() => writeFile(path, JSON.stringify({
        provider, providers: provider === "custom"
          ? { custom: { endpoint: "http://unused.invalid/v1/decisions", model: "fake" } }
          : { zen: { model: "jev-1.13-free", apiKey: "test-key" } }, permissions,
      })))
      vi.stubEnv("JEVVY_CONFIG", path)

      expect(yield* loadJevvyConfig(path, ConfigProvider.fromUnknown({})).pipe(Effect.provide(NodeFileSystem.layer))).toMatchObject({ kind })

      const entered = yield* Deferred.make()
      let finish

      const fetch = vi.fn((_url, options) => {
        const request = JSON.parse(options.body)

        const result = {
          model: "fake", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0 }])),
        }

        return new Promise((resolve) => {
          finish = () => resolve(new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } }))
          Deferred.doneUnsafe(entered, Effect.succeed(request))
        })
      })

      const running = yield* (harness === "opencode" ? openCodeReview() : claudeReview()).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.forkChild,
      )

      const request = yield* Deferred.await(entered)
      expect(request.model).toBe(provider === "custom" ? "fake" : "jev-1.13-free")

      yield* TestClock.adjust(timeoutMs === undefined ? "5 seconds" : "6 seconds")
      finish()

      expect(yield* Fiber.join(running)).toBe(timeoutMs !== undefined)
      expect(fetch).toHaveBeenCalledOnce()

      if (kind === "custom-policy") expect(Object.keys(request.questions)).toEqual(["harmful"])
      else expect(Object.keys(request.questions)).toEqual(["harmful", "sensitive", "untrusted", "obscured"])
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true })),
  ))
})

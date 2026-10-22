import { afterEach, describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import plugin from "../packages/permissions/src/opencode/index.ts"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("OpenCode credential adapter", () => {
  it.effect.each(["saved-key", "file-key", "environment-key", "oauth"])("handles %s at plugin setup", (mode) => Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(), "jevvy-credential-"))),
    (directory) => Effect.gen(function*() {
      vi.spyOn(console, "info").mockImplementation(() => {})
      vi.spyOn(console, "warn").mockImplementation(() => {})

      const path = join(directory, "jevvy.jsonc")
      const settings = { opencodeCredential: "openrouter", apiKey: mode === "file-key" ? "fixture-file-key" : undefined }

      yield* Effect.promise(() => writeFile(path, JSON.stringify({ provider: "openrouter", providers: { openrouter: settings } }), { mode: 0o600 }))

      vi.stubEnv("JEVVY_CONFIG", path)
      vi.stubEnv("OPENROUTER_API_KEY", mode === "environment-key" ? "fixture-env-key" : undefined)

      const hooks = new Map()
      const hook = (name, handler) => Effect.sync(() => { hooks.set(name, handler) })
      const active = vi.fn(() => Effect.succeed({ type: "credential", id: "cred_fixture", label: "fixture", method: mode === "oauth" ? "oauth" : "key" }))

      const resolve = vi.fn(() => Effect.succeed(mode === "oauth"
        ? { type: "oauth", methodID: "oauth", refresh: "fixture-refresh", access: "fixture-access", expires: 0 }
        : { type: "key", key: "fixture-host-key" }))

      const fetch = vi.fn((_url, input) => {
        const body = JSON.parse(input.body)
        const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0 }]))

        return Promise.resolve(Response.json({ model: "fixture-model", answers }))
      })

      yield* plugin.effect({
        rpc: { register: () => Effect.succeed({}) },
        command: { transform: () => Effect.void },
        tool: { hook },
        shell: { hook },
        permission: { hook },
        session: { get: () => Effect.succeed({ agent: "build", location: { directory } }) },
        agent: { get: () => Effect.succeed({ data: { permissions: [] } }) },
        integration: { connection: { active, resolve } },
      })

      if (mode === "oauth") {
        expect(active).toHaveBeenCalledExactlyOnceWith("openrouter")
        expect(resolve).not.toHaveBeenCalled()
        expect(hooks.has("evaluate")).toBe(false)

        return
      }

      if (mode === "saved-key") {
        expect(active).toHaveBeenCalledExactlyOnceWith("openrouter")
        expect(resolve).toHaveBeenCalledOnce()
      } else {
        expect(active).not.toHaveBeenCalled()
        expect(resolve).not.toHaveBeenCalled()
      }

      yield* hooks.get("execute.before")({ tool: "shell", sessionID: "ses_fixture", messageID: "msg_fixture", id: "call_fixture", input: { command: "pwd" } })
      yield* hooks.get("create.before")({ command: "pwd", cwd: directory, timeout: 1000, shell: "/bin/bash", env: {} })

      const event = { sessionID: "ses_fixture", action: "shell", resources: ["pwd"], effect: "ask", source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" } }

      yield* hooks.get("evaluate")(event).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))

      expect(event.effect).toBe("allow")
      expect(fetch).toHaveBeenCalledOnce()

      const expectedKey = {
        "saved-key": "fixture-host-key",
        "file-key": "fixture-file-key",
        "environment-key": "fixture-env-key",
      }[mode]

      expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe(`Bearer ${expectedKey}`)
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ))
})

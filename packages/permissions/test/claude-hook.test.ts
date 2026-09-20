import { describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import type { PermissionRequest, PermissionReview, PermissionReviewer } from "../src/engine.ts"
import { permissionAllowOutput, setupUnavailableOutput } from "../src/claude/evaluate.ts"
import {
  createClaudeHookHandler,
  missingClaudeConfigurationMessage,
  missingClaudeCredentialMessage,
} from "../src/claude/hook.ts"

const permissionEvent = (command = "pwd") => ({
  session_id: "ses_test",
  prompt_id: "prompt_test",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/workspace",
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command },
})

const sessionStartEvent = (source = "startup") => ({
  session_id: "ses_test",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/workspace",
  hook_event_name: "SessionStart",
  source,
})

const reviewer = (review: PermissionReview, calls: PermissionRequest[]): PermissionReviewer => ({
  review: (request) => Effect.sync(() => {
    calls.push(request)

    return review
  }),
})

const ready = (permissionReviewer: PermissionReviewer) => ({
  kind: "ready" as const,
  reviewer: permissionReviewer,
})

const unavailable = (message = "Jevvy setup is incomplete") => ({
  kind: "unavailable" as const,
  message,
})

describe("Claude Code hook process mapping", () => {
  it("explains assisted and manual setup when no provider is configured", () => {
    const path = "/home/user/.config/jevvy/jevvy.jsonc"

    expect(missingClaudeConfigurationMessage(path)).toBe(
      `
⚠ Jevvy setup required!

Auto-approval is off because no provider is configured.
Run: npx @jevvy/permissions init
Or configure ${path} manually.

Claude Code permissions are unchanged.`,
    )
  })

  it.each([
    ["zen", "OpenCode Zen", "OPENCODE_API_KEY", "providers.zen.apiKey"],
    ["typesafe", "TypeSafe AI", "TYPESAFE_API_KEY", "providers.typesafe.apiKey"],
    ["openrouter", "OpenRouter", "OPENROUTER_API_KEY", "providers.openrouter.apiKey"],
    ["vercel", "Vercel AI Gateway", "AI_GATEWAY_API_KEY", "providers.vercel.apiKey"],
  ] as const)("explains how Claude Code can configure missing %s credentials", (provider, label, environment, config) => {
    const message = missingClaudeCredentialMessage(provider, "/home/user/.config/jevvy/jevvy.jsonc")

    expect(message).toContain(label)
    expect(message).toContain(environment)
    expect(message).toContain(config)
    expect(message).toContain("npx @jevvy/permissions init")
    expect(message).toContain("Claude Code permissions are unchanged")
    expect(message).not.toContain("opencode auth login")
  })

  it.effect("writes only the documented allow response", () => Effect.gen(function*() {
    const calls: PermissionRequest[] = []
    const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, calls)))
    const output = yield* createClaudeHookHandler(load)(JSON.stringify(permissionEvent("  git status  ")))

    expect(output).toBe(JSON.stringify(permissionAllowOutput))
    expect(calls).toEqual([{ action: "shell", resources: ["  git status  "] }])
    expect(output).not.toContain("deny")
    expect(output).not.toContain("updatedInput")
    expect(output).not.toContain("updatedPermissions")
  }))

  it.effect.each(["judged", "unavailable", "empty"] as const)(
    "keeps stdout empty on %s ask",
    (reason) => Effect.gen(function*() {
      const load = () => Effect.succeed(ready(reviewer({ effect: "ask", reason, judgments: [] }, [])))

      expect(yield* createClaudeHookHandler(load)(JSON.stringify(permissionEvent()))).toBeUndefined()
    }),
  )

  it.effect("keeps stdout empty when credentials are missing", () => Effect.gen(function*() {
    const output = yield* createClaudeHookHandler(() => Effect.succeed(unavailable()))(
      JSON.stringify(permissionEvent()),
    )

    expect(output).toBeUndefined()
  }))

  it.effect("reports unavailable setup when a session starts", () => Effect.gen(function*() {
    const setup = unavailable("Set TYPESAFE_API_KEY to enable Jevvy auto-approval")

    const output = yield* createClaudeHookHandler(() => Effect.succeed(setup))(
      JSON.stringify(sessionStartEvent()),
    )

    expect(output).toBe(JSON.stringify(setupUnavailableOutput(setup.message)))
    expect(output).not.toContain("decision")
  }))

  it.effect("keeps stdout empty at session start when setup is ready", () => Effect.gen(function*() {
    const setup = ready(reviewer({ effect: "allow", judgments: [] }, []))

    const output = yield* createClaudeHookHandler(() => Effect.succeed(setup))(
      JSON.stringify(sessionStartEvent()),
    )

    expect(output).toBeUndefined()
  }))

  it.effect("keeps stdout empty when reviewer setup fails", () => Effect.gen(function*() {
    const output = yield* createClaudeHookHandler(() => Effect.fail(new Error("unavailable")))(
      JSON.stringify(permissionEvent()),
    )

    expect(output).toBeUndefined()
  }))

  it.effect("keeps stdout empty when setup inspection fails at session start", () => Effect.gen(function*() {
    const output = yield* createClaudeHookHandler(() => Effect.fail(new Error("unavailable")))(
      JSON.stringify(sessionStartEvent()),
    )

    expect(output).toBeUndefined()
  }))

  it.effect("does not load configuration for malformed input", () => Effect.gen(function*() {
    const allowReviewer = reviewer({ effect: "allow", judgments: [] }, [])
    const load = vi.fn(() => Effect.succeed(ready(allowReviewer)))

    expect(yield* createClaudeHookHandler(load)("not json")).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  }))

  it.effect.each([
    { ...permissionEvent(), hook_event_name: "PreToolUse" },
    { ...permissionEvent(), tool_name: "Write" },
    { ...permissionEvent(), tool_input: { command: "   " } },
    { ...permissionEvent(), permission_mode: "unknown" },
    { ...sessionStartEvent(), source: "unknown" },
    { tool_name: "Bash", tool_input: { command: "pwd" } },
  ])("does not load configuration for unsupported or malformed input", (input) => Effect.gen(function*() {
    const load = vi.fn(() => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, []))))

    expect(yield* createClaudeHookHandler(load)(JSON.stringify(input))).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  }))

  it.effect.each(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"])(
    "accepts the documented %s permission mode",
    (permissionMode) => Effect.gen(function*() {
      const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, [])))
      const input = { ...permissionEvent(), permission_mode: permissionMode }

      expect(yield* createClaudeHookHandler(load)(JSON.stringify(input))).toBe(JSON.stringify(permissionAllowOutput))
    }),
  )

  it.effect.each(["startup", "resume", "clear", "compact", "fork"])(
    "accepts the documented %s session start source",
    (source) => Effect.gen(function*() {
      const setup = unavailable()

      const output = yield* createClaudeHookHandler(() => Effect.succeed(setup))(
        JSON.stringify(sessionStartEvent(source)),
      )

      expect(output).toBe(JSON.stringify(setupUnavailableOutput(setup.message)))
    }),
  )

  it.effect("ignores advisory permission suggestions", () => Effect.gen(function*() {
    const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, [])))

    const input = {
      ...permissionEvent(),
      permission_suggestions: [{ type: "addRules", behavior: "allow", destination: "localSettings" }],
    }

    expect(yield* createClaudeHookHandler(load)(JSON.stringify(input))).toBe(JSON.stringify(permissionAllowOutput))
  }))
})

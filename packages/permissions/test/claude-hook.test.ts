import { describe, expect, it, vi } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { createPermissionReviewer } from "../src/engine.ts"
import type { PermissionRequest, PermissionReview, PermissionReviewer } from "../src/engine.ts"
import { permissionAllowOutput, setupUnavailableOutput } from "../src/claude/evaluate.ts"
import {
  createClaudeHookHandler as makeClaudeHookHandler,
  invalidClaudeConfigurationMessage,
  missingClaudeConfigurationMessage,
  missingClaudeCredentialMessage,
} from "../src/claude/hook.ts"
import type { ClaudeSetupLoader } from "../src/claude/hook.ts"

const createClaudeHookHandler = <E>(load: ClaudeSetupLoader<E>) =>
  makeClaudeHookHandler(load, () => Effect.succeed([]))

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
  it.effect("OFF skips setup and cached approvals, and ON reuses the owning process cache", () => Effect.gen(function*() {
    let enabled = true

    const provider = vi.fn(() => Effect.succeed({ model: "fake", answers: {
      harmless: { type: "noul" as const, noul: 0 },
    } }))

    const cachedReviewer = yield* createPermissionReviewer({ evaluate: provider }, {
      questions: { harmless: { type: "noul", instructions: "Is this harmful?", threshold: 0.5 } },
    })

    const review = vi.fn(cachedReviewer.review)
    const setup = vi.fn(() => Effect.succeed(ready({ review })))
    const asks = vi.fn(() => Effect.succeed(["Bash"]))
    const handler = makeClaudeHookHandler(setup, asks, { read: () => Effect.succeed({ enabled }) })
    const raw = JSON.stringify(permissionEvent())
    expect(yield* handler(raw)).toEqual(permissionAllowOutput)
    enabled = false
    expect(yield* handler(raw)).toBeUndefined()
    expect(setup).toHaveBeenCalledOnce()
    expect(asks).toHaveBeenCalledOnce()
    expect(review).toHaveBeenCalledOnce()
    enabled = true
    expect(yield* handler(raw)).toEqual(permissionAllowOutput)
    expect(review).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledOnce()
  }))

  it.effect("OFF lets a started hook approval finish while new hooks abstain", () => Effect.gen(function*() {
    let enabled = true
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()

    const review = vi.fn(() => Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)

      return { effect: "allow" as const, judgments: [] }
    }))

    const handler = makeClaudeHookHandler(() => Effect.succeed(ready({ review })), () => Effect.succeed(["Bash"]), {
      read: () => Effect.succeed({ enabled }),
    })

    const raw = JSON.stringify(permissionEvent())
    const running = yield* handler(raw).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    enabled = false
    expect(yield* handler(raw)).toBeUndefined()
    yield* Deferred.succeed(finish, undefined)
    expect(yield* Fiber.join(running)).toEqual(permissionAllowOutput)
    expect(review).toHaveBeenCalledOnce()
  }))

  it.effect.each(["Bash", "Bash(*)"])("reviews a %s review ask as one complete command", (rule) => Effect.gen(function*() {
    const calls: PermissionRequest[] = []
    const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, calls)))
    const handler = makeClaudeHookHandler(load, () => Effect.succeed([rule]))
    const command = "cd src && echo hello > output.txt"

    expect(yield* handler(JSON.stringify(permissionEvent(command)))).toEqual(permissionAllowOutput)
    expect(calls).toEqual([{ action: "shell", resources: [command] }])
  }))

  it.effect.each([
    { rules: ["Bash", "Bash(git push *)"] },
    { rules: ["Bash(git push *)", "Bash"] },
    { rules: ["Bash(*)", "Bash(git push *)"] },
    { rules: ["Bash(git push *)", "Bash(*)"] },
  ])("preserves a host ask alongside review asks %j", ({ rules }) => Effect.gen(function*() {
    const setup = vi.fn(() => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, []))))
    const handler = makeClaudeHookHandler(setup, () => Effect.succeed(rules))

    expect(yield* handler(JSON.stringify(permissionEvent("echo hello && git push origin main")))).toBeUndefined()
    expect(setup).not.toHaveBeenCalled()
  }))

  it.effect("leaves the host's remaining flow unchanged when a review ask does not allow", () => Effect.gen(function*() {
    const calls: PermissionRequest[] = []
    const load = () => Effect.succeed(ready(reviewer({ effect: "ask", reason: "judged", judgments: [] }, calls)))
    const handler = makeClaudeHookHandler(load, () => Effect.succeed(["Bash"]))

    expect(yield* handler(JSON.stringify(permissionEvent()))).toBeUndefined()
    expect(calls).toEqual([{ action: "shell", resources: ["pwd"] }])
  }))

  it.effect("leaves a specific Bash ask to the host without loading Jevvy", () => Effect.gen(function*() {
    const setup = vi.fn(() => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, []))))
    const handler = makeClaudeHookHandler(setup, () => Effect.succeed(["Bash(pnpm build)"]))

    expect(yield* handler(JSON.stringify(permissionEvent("pnpm build")))).toBeUndefined()
    expect(setup).not.toHaveBeenCalled()
  }))

  it.effect("leaves a host ask inside shell control flow untouched", () => Effect.gen(function*() {
    const setup = vi.fn(() => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, []))))
    const handler = makeClaudeHookHandler(setup, () => Effect.succeed(["Bash(git push *)"]))

    expect(yield* handler(JSON.stringify(permissionEvent("if true; then git push origin main; fi")))).toBeUndefined()
    expect(yield* handler(JSON.stringify(permissionEvent("! git push origin main")))).toBeUndefined()
    expect(setup).not.toHaveBeenCalled()
  }))

  it.effect("reviews the complete command when visible ask rules do not match", () => Effect.gen(function*() {
    const calls: PermissionRequest[] = []
    const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, calls)))
    const handler = makeClaudeHookHandler(load, () => Effect.succeed(["Bash(git push *)"]))

    expect(yield* handler(JSON.stringify(permissionEvent("echo hello && pnpm build")))).toEqual(permissionAllowOutput)
    expect(calls).toEqual([{ action: "shell", resources: ["echo hello && pnpm build"] }])

    expect(yield* handler(JSON.stringify(permissionEvent("pnpm build")))).toEqual(permissionAllowOutput)
    expect(calls).toEqual([
      { action: "shell", resources: ["echo hello && pnpm build"] },
      { action: "shell", resources: ["pnpm build"] },
    ])
  }))

  it.effect("abstains when settings cannot be read", () => Effect.gen(function*() {
    const calls: PermissionRequest[] = []
    const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, calls)))
    const handler = makeClaudeHookHandler(load, () => Effect.succeed(undefined))

    expect(yield* handler(JSON.stringify(permissionEvent()))).toBeUndefined()
    expect(calls).toHaveLength(0)
  }))
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

  it("explains an incomplete manual Laya policy without suggesting init would calibrate it", () => {
    const message = invalidClaudeConfigurationMessage(
      "/home/user/.config/jevvy/jevvy.jsonc",
      "Laya requires providers.laya.policy with matching checkpoint and questions",
    )

    expect(message).toContain("Laya requires providers.laya.policy with matching checkpoint and questions")
    expect(message).toContain("Fix the file before enabling auto-approval")
    expect(message).toContain("Claude Code permissions are unchanged")
    expect(message).not.toContain("run: npx @jevvy/permissions init")
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

    expect(output).toEqual(permissionAllowOutput)
    expect(calls).toEqual([{ action: "shell", resources: ["  git status  "] }])
    expect(JSON.stringify(output)).not.toContain("deny")
    expect(JSON.stringify(output)).not.toContain("updatedInput")
    expect(JSON.stringify(output)).not.toContain("updatedPermissions")
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

    expect(output).toEqual(setupUnavailableOutput(setup.message))
    expect(JSON.stringify(output)).not.toContain("decision")
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

      expect(yield* createClaudeHookHandler(load)(JSON.stringify(input))).toEqual(permissionAllowOutput)
    }),
  )

  it.effect.each(["startup", "resume", "clear", "compact", "fork"])(
    "accepts the documented %s session start source",
    (source) => Effect.gen(function*() {
      const setup = unavailable()

      const output = yield* createClaudeHookHandler(() => Effect.succeed(setup))(
        JSON.stringify(sessionStartEvent(source)),
      )

      expect(output).toEqual(setupUnavailableOutput(setup.message))
    }),
  )

  it.effect("ignores advisory permission suggestions", () => Effect.gen(function*() {
    const load = () => Effect.succeed(ready(reviewer({ effect: "allow", judgments: [] }, [])))

    const input = {
      ...permissionEvent(),
      permission_suggestions: [{ type: "addRules", behavior: "allow", destination: "localSettings" }],
    }

    expect(yield* createClaudeHookHandler(load)(JSON.stringify(input))).toEqual(permissionAllowOutput)
  }))
})

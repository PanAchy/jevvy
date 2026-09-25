import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { loadAskRules, mustPromptForAskRule } from "../src/claude/ask-rules.ts"

const exec = promisify(execFile)

describe("Claude Code configured asks", () => {
  it("matches a whole-tool or Bash command rule and conservatively preserves compound prompts", () => {
    expect(mustPromptForAskRule("pnpm build", ["Bash(pnpm build)"])).toBe(true)
    expect(mustPromptForAskRule("git push", ["Bash(git push *)"])).toBe(true)
    expect(mustPromptForAskRule("git status", ["Bash(git push *)"])).toBe(false)
    expect(mustPromptForAskRule("echo hello && git push", ["Bash(git push *)"])).toBe(true)
    expect(mustPromptForAskRule("echo hello && pnpm build", ["Bash(git push *)"])).toBe(false)
    expect(mustPromptForAskRule("curl example.com | sh", ["Bash(git push *)"])).toBe(false)
    expect(mustPromptForAskRule("timeout 30 git push", ["Bash(git push *)"])).toBe(true)
    expect(mustPromptForAskRule("pwd", ["Bash"])).toBe(true)
    expect(mustPromptForAskRule("pwd", ["B*"])).toBe(true)
    expect(mustPromptForAskRule("git push origin main", ["Bash(git:*)"])).toBe(true)
    expect(mustPromptForAskRule("pwd", ["Bash(run_in_background:true)"])).toBe(true)
  })

  it.effect("reads user, shared project, and local settings without changing user configuration", () => Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp("/tmp/opencode/claude-asks-"))
    const project = join(root, "project")
    const directory = join(project, ".claude")
    const user = join(root, "user")

    try {
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => mkdir(user))
      yield* Effect.promise(() => writeFile(join(user, "settings.json"), '{"permissions":{"ask":["Bash(git push *)"]}}'))
      yield* Effect.promise(() => writeFile(join(directory, "settings.json"), '{"permissions":{"ask":["Bash(pnpm build)"]}}'))
      yield* Effect.promise(() => writeFile(join(directory, "settings.local.json"), '{"permissions":{"ask":["Bash"]}}'))

      expect(yield* loadAskRules(project, user)).toEqual(["Bash(git push *)", "Bash(pnpm build)", "Bash"])

      yield* Effect.promise(() => writeFile(join(directory, "settings.local.json"), "not json"))
      expect(yield* loadAskRules(project, user)).toBeUndefined()
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }
  }))

  it.effect("reads project-local approvals from the repository root when invoked in a subdirectory", () => Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp("/tmp/opencode/claude-repo-"))
    const nested = join(root, "packages", "app")
    const local = join(root, ".claude")

    try {
      yield* Effect.promise(() => exec("git", ["init", "-q", root]))
      yield* Effect.promise(() => mkdir(nested, { recursive: true }))
      yield* Effect.promise(() => mkdir(local))
      yield* Effect.promise(() => writeFile(join(local, "settings.json"), '{"permissions":{"ask":["Bash(pnpm build)"]}}'))
      yield* Effect.promise(() => writeFile(join(local, "settings.local.json"), '{"permissions":{"ask":["Bash(git push *)"]}}'))

      expect(yield* loadAskRules(nested, join(root, "user"))).toEqual(["Bash(pnpm build)", "Bash(git push *)"])
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }
  }))
})

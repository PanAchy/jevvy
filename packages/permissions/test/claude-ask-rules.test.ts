import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as TestClock from "effect/testing/TestClock"
import { NodeServices } from "@effect/platform-node"
import { hasHostAsk, loadAskRules as inspectAskRules } from "../src/claude/ask-rules.ts"

const loadAskRules = (cwd: string, configDir: string) => inspectAskRules(cwd, configDir).pipe(Effect.provide(NodeServices.layer))

const exec = promisify(execFile)

const makeScratch = (prefix: string) => Effect.gen(function*() {
  const parent = join(tmpdir(), "opencode")
  yield* Effect.promise(() => mkdir(parent, { recursive: true }))

  return yield* Effect.promise(() => mkdtemp(join(parent, prefix)))
})

describe("Claude Code configured asks", () => {
  it("matches host asks and conservatively preserves compound requests", () => {
    expect(hasHostAsk("pnpm build", ["Bash(pnpm build)"])).toBe(true)
    expect(hasHostAsk("git push", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("git status", ["Bash(git push *)"])).toBe(false)
    expect(hasHostAsk("echo hello && git push", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("echo hello && pnpm build", ["Bash(git push *)"])).toBe(false)
    expect(hasHostAsk("curl example.com | sh", ["Bash(git push *)"])).toBe(false)
    expect(hasHostAsk("timeout 30 git push", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("if true; then git push origin main; fi", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("! git push origin main", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("for branch in main; do git push origin main; done", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("if true; then echo safe; fi", ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk("if true; then echo safe; fi", [])).toBe(false)
    expect(hasHostAsk("echo then", ["Bash(git push *)"])).toBe(false)
    expect(hasHostAsk("pwd", ["Bash"])).toBe(false)
    expect(hasHostAsk("pwd", ["B*"])).toBe(true)
    expect(hasHostAsk("git push origin main", ["Bash(git:*)"])).toBe(true)
    expect(hasHostAsk("pwd", ["Bash(run_in_background:true)"])).toBe(true)
  })

  it.each(["Bash", "Bash(*)"])("treats %s as a review ask for the complete command", (rule) => {
    for (const command of ["pwd", "echo hello && git status", "cd src && printf 'hello' > output.txt", "echo $(date)"]) {
      expect(hasHostAsk(command, [rule])).toBe(false)
    }
  })

  it.each(["Bash", "Bash(*)"])("preserves specific host asks alongside %s regardless of order", (rule) => {
    for (const rules of [[rule, "Bash(git push *)"], ["Bash(git push *)", rule]]) {
      expect(hasHostAsk("git push origin main", rules)).toBe(true)
      expect(hasHostAsk("echo hello && git push origin main", rules)).toBe(true)
      expect(hasHostAsk("git status", rules)).toBe(false)
      expect(hasHostAsk("echo $(git status)", rules)).toBe(true)
    }
  })

  it("keeps non-baseline wildcards and malformed Bash asks under host control", () => {
    expect(hasHostAsk("pwd", ["*"])).toBe(true)
    expect(hasHostAsk("pwd", ["Bash(**)"])).toBe(true)
    expect(hasHostAsk("pwd", ["Bash("])).toBe(true)
  })

  it.each([
    "timeout 30 git status",
    "time git status",
    "nice git status",
    "nohup git status",
    "stdbuf -oL git status",
    "command git status",
    "builtin pwd",
    "noglob git status",
    "xargs git status",
    "env git status",
    "MODE=test git status",
    "if true; then git status; fi",
    "! git status",
    "echo $(git status)",
    "echo `git status`",
    "echo 'git status'",
    "git status &&",
  ])("leaves ambiguous command %s to the host only when a Bash host ask exists", (command) => {
    expect(hasHostAsk(command, ["Bash(git push *)"])).toBe(true)
    expect(hasHostAsk(command, ["Bash", "Bash(*)", "Read(*)"])).toBe(false)
    expect(hasHostAsk(command, [])).toBe(false)
  })

  it.each(["Bash(run_in_background:true)", "Bash(timeout:1000)"])("leaves input-parameter ask %s to the host", (rule) => {
    expect(hasHostAsk("pwd", [rule])).toBe(true)
  })

  it("keeps command-prefix asks distinct from input-parameter asks", () => {
    expect(hasHostAsk("git status", ["Bash(git:*)"])).toBe(true)
    expect(hasHostAsk("pwd", ["Bash(git:*)"])).toBe(false)
  })

  it.effect("reads user, shared project, and local settings without changing user configuration", () => Effect.gen(function*() {
    const root = yield* makeScratch("claude-asks-")
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
    const root = yield* makeScratch("claude-repo-")
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

  it.effect("reads both worktree settings and primary-repository local settings", () => Effect.gen(function*() {
    const parent = yield* makeScratch("claude-worktree-")
    const repo = join(parent, "repo")
    const worktree = join(parent, "worktree")

    try {
      yield* Effect.promise(() => exec("git", ["init", "-q", repo]))
      yield* Effect.promise(() => exec("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: repo }))
      yield* Effect.promise(() => exec("git", ["worktree", "add", "--detach", worktree], { cwd: repo }))
      yield* Effect.promise(() => mkdir(join(repo, ".claude")))
      yield* Effect.promise(() => mkdir(join(worktree, ".claude")))
      yield* Effect.promise(() => writeFile(join(repo, ".claude", "settings.local.json"), '{"permissions":{"ask":["Bash(git push *)"]}}'))
      yield* Effect.promise(() => writeFile(join(worktree, ".claude", "settings.json"), '{"permissions":{"ask":["Bash(pnpm build)"]}}'))
      expect(yield* loadAskRules(worktree, join(parent, "user"))).toEqual(["Bash(pnpm build)", "Bash(git push *)"])
    } finally {
      yield* Effect.promise(() => rm(parent, { recursive: true, force: true }))
    }
  }))

  for (const mode of ["timeout", "interrupt"] as const) {
    it.effect(`releases Git inspection on ${mode} without granting approval`, () => Effect.gen(function*() {
      const root = yield* makeScratch("claude-git-scope-")
      const entered = yield* Deferred.make<void>()
      let released = false

      const spawner = ChildProcessSpawner.make(() => Effect.acquireRelease(
        Deferred.succeed(entered, undefined).pipe(Effect.as(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1), stdin: Sink.drain, stdout: Stream.never, stderr: Stream.empty, all: Stream.never,
          exitCode: Effect.never, isRunning: Effect.succeed(true), kill: () => Effect.void,
          getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
        }))),
        () => Effect.sync(() => { released = true }),
      ))

      try {
        yield* Effect.promise(() => mkdir(join(root, ".git")))

        const fiber = yield* inspectAskRules(root, join(root, "user")).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.provide(NodeServices.layer), Effect.forkChild,
        )

        yield* Deferred.await(entered)

        if (mode === "timeout") {
          yield* TestClock.adjust("2 seconds")
          expect(yield* Fiber.join(fiber)).toBeUndefined()
        } else {
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
        }

        expect(released).toBe(true)
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
      }
    }))
  }
})

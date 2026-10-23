import { describe, expect, it, vi } from "@effect/vitest"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import { createClaudeHookHandler } from "../src/claude/hook.ts"
import { checkClaudeHistorySetup } from "../src/claude/history-setup.ts"
import { createHistoryFiles } from "../src/history/history-files.ts"
import { HistoryNativeError, historyNative } from "../src/history/history-native.ts"
import { HistoryStorageError } from "../src/history.ts"

const sessionStart = JSON.stringify({ session_id: "fixture", transcript_path: "/unused", cwd: "/workspace", hook_event_name: "SessionStart", source: "startup" })

const configuration = (enabled = true) => ({ kind: "configured" as const, configuration: {}, reviewAskPatterns: [], history: { enabled, configPath: "/private/jevvy.jsonc", provider: "custom" as const } })

const ready = () => Effect.succeed({ kind: "ready" as const, reviewer: { review: () => Effect.die("SessionStart must not review") } })

const readonlyFiles = () => ({ ...historyNative,
  mkdir: vi.fn(() => Effect.die("Preflight must not create directories")),
  open: vi.fn(() => Effect.die("Preflight must not open files")),
})

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(async () => mkdtemp(join(await realpath("/tmp"), "jevvy-history-preflight-"))),
  use,
  (root) => Effect.promise(() => rm(root, { recursive: true })),
)

describe("Claude history SessionStart diagnostics", () => {
  it.effect.each(["unsupported-platform", "unsafe-path", "unsupported-schema"] as const)("reports safe actionable %s without allocating history", (kind) => Effect.gen(function*() {
    const storage = vi.fn(() => Effect.die("SessionStart must not acquire storage"))
    const check = (config: { configPath: string }) => checkClaudeHistorySetup(config, () => new HistoryStorageError({ kind }))
    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), ready, () => Effect.die("SessionStart must not inspect asks"), undefined, storage, check)
    const output = yield* handler(sessionStart)
    expect(output).toMatchObject({ systemMessage: expect.stringContaining("Jevvy Permissions review history is unavailable") })
    expect(output).toMatchObject({ systemMessage: expect.stringContaining("metrics.enabled to false") })
    expect(output).toMatchObject({ systemMessage: expect.stringContaining("Permission reviews are unchanged") })
    expect(storage).not.toHaveBeenCalled()
  }))

  it.effect("preserves provider setup diagnostics alongside the history warning", () => Effect.gen(function*() {
    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), () => Effect.succeed({ kind: "unavailable", message: "Set TYPESAFE_API_KEY" }), () => Effect.succeed([]), undefined, undefined,
      (config) => checkClaudeHistorySetup(config, () => new HistoryStorageError({ kind: "unsafe-path" })))

    const output = yield* handler(sessionStart)
    expect(output).toMatchObject({ systemMessage: expect.stringContaining("Set TYPESAFE_API_KEY\n\nJevvy Permissions") })
  }))

  it.effect.each(["disabled", "unknown-config", "unsupported-input", "permission-request"] as const)("does not probe history for %s", (mode) => Effect.gen(function*() {
    const check = vi.fn(() => Effect.die("Unexpected preflight"))
    const handler = createClaudeHookHandler(() => Effect.succeed(mode === "unknown-config" ? { kind: "unavailable" as const, message: "Invalid configuration" } : configuration(mode !== "disabled")), ready, () => Effect.succeed(["Bash(echo *)"]), undefined, undefined, check)
    const raw = mode === "permission-request" ? JSON.stringify({ session_id: "fixture", prompt_id: "fixture", transcript_path: "/unused", cwd: "/workspace", permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo host-owned" } }) : sessionStart
    yield* handler(mode === "unsupported-input" ? "{}" : raw)
    expect(check).not.toHaveBeenCalled()
  }))

  it.effect.each(["busy", "storage"] as const)("does not turn a transient %s probe into a permanent warning", (kind) => Effect.gen(function*() {
    expect(yield* checkClaudeHistorySetup({ configPath: "unused" }, () => new HistoryStorageError({ kind }))).toBeUndefined()
  }))

  it.effect.each(["synchronous", "effect"] as const)("a %s probe defect cannot hide an existing provider setup diagnostic", (stage) => Effect.gen(function*() {
    const handler = createClaudeHookHandler(() => Effect.succeed(configuration()), () => Effect.succeed({ kind: "unavailable", message: "Set TYPESAFE_API_KEY" }), () => Effect.succeed([]), undefined, undefined,
      (config) => checkClaudeHistorySetup(config, () => {
        if (stage === "synchronous") throw new Error("arbitrary-native-error")

        return Effect.die("arbitrary-native-error")
      }))

    expect(yield* handler(sessionStart)).toEqual({ systemMessage: "Set TYPESAFE_API_KEY" })
  }))

  it.effect("bounds a slow probe and preserves interruption", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const probe = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    const running = yield* checkClaudeHistorySetup({ configPath: "unused" }, probe).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* TestClock.adjust("500 millis")
    expect(yield* Fiber.join(running)).toBeUndefined()
    const interrupted = yield* checkClaudeHistorySetup({ configPath: "unused" }, () => Effect.interrupt).pipe(Effect.exit)
    expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
  }))

  it.effect("Windows is diagnosed without any filesystem operation", () => Effect.gen(function*() {
    const files = { ...readonlyFiles(), lstat: vi.fn(() => Effect.die("Windows must not inspect paths")), opendir: vi.fn(() => Effect.die("Windows must not enumerate")) }
    const { preflightHistoryStore } = createHistoryFiles(files, "win32")
    expect(yield* checkClaudeHistorySetup({ configPath: "unused" }, preflightHistoryStore)).toContain("unavailable on Windows")
    expect(files.lstat).not.toHaveBeenCalled()
    expect(files.opendir).not.toHaveBeenCalled()
  }))
})

describe.skipIf(process.platform === "win32")("read-only history path preflight", () => {
  it.effect.each(["missing", "empty", "initializing"] as const)("accepts %s metrics without opening files or changing the filesystem", (state) => fixture((root) => Effect.gen(function*() {
    const metrics = join(root, "metrics")

    if (state !== "missing") yield* Effect.promise(() => mkdir(metrics, { mode: 0o700 }))

    if (state === "initializing") {
      yield* Effect.promise(() => writeFile(join(metrics, "history.sqlite-journal"), "partial", { mode: 0o600 }))
      yield* Effect.promise(() => writeFile(join(metrics, "AGENTS.md"), "partial", { mode: 0o600 }))
    }

    const before = yield* Effect.promise(() => readdir(root))
    const files = readonlyFiles()
    const preflight = createHistoryFiles(files).preflightHistoryStore
    expect(yield* checkClaudeHistorySetup({ configPath: join(root, "jevvy.jsonc") }, preflight)).toBeUndefined()
    expect(yield* Effect.promise(() => readdir(root))).toEqual(before)
    expect(files.open).not.toHaveBeenCalled()
    expect(files.mkdir).not.toHaveBeenCalled()

    if (state === "empty") expect(yield* Effect.promise(() => readdir(metrics))).toEqual([])

    if (state === "initializing") expect(yield* Effect.promise(() => readFile(join(metrics, "AGENTS.md"), "utf8"))).toBe("partial")
  })))

  it.effect.each(["global-root", "metrics-directory", "database", "metadata", "symlink", "hardlink"] as const)("diagnoses an unsafe %s using the writer privacy criteria", (kind) => fixture((root) => Effect.gen(function*() {
    const metrics = join(root, "metrics")
    yield* Effect.promise(() => mkdir(metrics, { mode: 0o700 }))
    const database = join(metrics, "history.sqlite")
    const metadata = join(metrics, "AGENTS.md")
    yield* Effect.promise(() => writeFile(database, "", { mode: 0o600 }))
    yield* Effect.promise(() => writeFile(metadata, "partial", { mode: 0o600 }))

    if (kind === "global-root") yield* Effect.promise(() => chmod(root, 0o755))

    if (kind === "metrics-directory") yield* Effect.promise(() => chmod(metrics, 0o755))

    if (kind === "database") yield* Effect.promise(() => chmod(database, 0o644))

    if (kind === "metadata") yield* Effect.promise(() => chmod(metadata, 0o644))

    if (kind === "symlink") {
      yield* Effect.promise(() => rm(database))
      yield* Effect.promise(() => symlink(metadata, database))
    }

    if (kind === "hardlink") yield* Effect.promise(() => link(metadata, join(root, "second-link")))

    const before = yield* Effect.promise(() => lstat(metadata))
    const files = readonlyFiles()
    expect(yield* checkClaudeHistorySetup({ configPath: join(root, "jevvy.jsonc") }, createHistoryFiles(files).preflightHistoryStore)).toContain("not private")
    const after = yield* Effect.promise(() => lstat(metadata))
    expect([after.ino, after.mode, after.size, after.mtimeMs]).toEqual([before.ino, before.mode, before.size, before.mtimeMs])
    expect(files.open).not.toHaveBeenCalled()
    expect(files.mkdir).not.toHaveBeenCalled()
  })))

  it.effect("ignores a directory disappearing during enumeration", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.promise(() => mkdir(join(root, "metrics"), { mode: 0o700 }))
    const files = { ...readonlyFiles(), opendir: () => new HistoryNativeError({ kind: "missing" }) }
    expect(yield* checkClaudeHistorySetup({ configPath: join(root, "jevvy.jsonc") }, createHistoryFiles(files).preflightHistoryStore)).toBeUndefined()
  })))

  it.effect("bounds directory enumeration and closes the native directory port", () => fixture((root) => Effect.gen(function*() {
    yield* Effect.promise(() => mkdir(join(root, "metrics"), { mode: 0o700 }))
    let reads = 0
    let closed = false

    const files = { ...readonlyFiles(), opendir: () => Effect.succeed({
      read: Effect.sync(() => {
        reads++

        return { name: "unknown" }
      }),
      close: Effect.sync(() => { closed = true }),
    }) }

    expect(yield* checkClaudeHistorySetup({ configPath: join(root, "jevvy.jsonc") }, createHistoryFiles(files).preflightHistoryStore)).toContain("unsupported entries")
    expect(reads).toBe(6)
    expect(closed).toBe(true)
  })))
})

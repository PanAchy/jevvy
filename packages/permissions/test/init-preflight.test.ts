import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as TestClock from "effect/testing/TestClock"
import { harnessCommand } from "../src/init/harness-command.ts"
import { inspectHarness, opencodeCompatibilityWarning } from "../src/init/preflight.ts"

const handle = (version: string, code = 0) => ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1), stdin: Sink.drain,
  stdout: Stream.make(new TextEncoder().encode(version)), stderr: Stream.empty, all: Stream.empty,
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)), isRunning: Effect.succeed(false), kill: () => Effect.void,
  getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
})

describe("installer preflight", () => {
  it.each(["2.0.27", "2.0.28", "2.1.0", "3.0.0", " 2.0.27\n", "opencode v2.0.27\n", "opencode v2.0.29\n"])("accepts supported stable version %s", (version) => {
    expect(opencodeCompatibilityWarning(version)).toBeUndefined()
  })

  it.each(["2.0.26", "2.0.0", "1.9.9"])("warns before installing into old version %s", (version) => {
    const warning = opencodeCompatibilityWarning(version)
    expect(warning).toContain(`Detected OpenCode ${version}.`)
    expect(warning).toContain("requires OpenCode 2.0.27 or newer")
    expect(warning).toContain("Upgrade OpenCode")
    expect(warning).toContain("not a separate desktop app or remote server")

    if (version.startsWith("2.")) expect(warning).toContain("opencode plugin add @jevvy/permissions@0.5.1")
    else expect(warning).not.toContain("@0.5.1")
  })

  it("reports the actual version and upgrade guidance for a prefixed old CLI", () => {
    const warning = opencodeCompatibilityWarning("opencode v2.0.26\n")
    expect(warning).toContain("Detected OpenCode 2.0.26.")
    expect(warning).toContain("Upgrade OpenCode")
    expect(warning).toContain("opencode plugin add @jevvy/permissions@0.5.1")
  })

  it.each(["", "2.0", "nightly", "2.0.27-beta.1", "2.0.27\nother output", "opencode v2.0.27-beta.1", "opencode v2.0.27\nother output", "other v2.0.27", "9999999999999999999999999.0.27"])("requires an explicit choice for unknown version %s", (version) => {
    expect(opencodeCompatibilityWarning(version)).toContain("Could not verify the OpenCode CLI version")
  })

  it("uses the wizard's Windows command-wrapper handling to capture version output", () => {
    for (const [harness, args] of [
      ["opencode", ["--version"]],
      ["claude", ["--version"]],
    ] as const) {
      const command = harnessCommand(harness, args, { platform: "win32" })

      expect(command.command).toBe(harness)
      expect(command.args).toEqual(args)
      expect(command.options.shell).toBe(true)
      expect(command.options.stdin).toBe("pipe")
      expect(command.options.stdout).toBe("pipe")
      expect(command.options.stderr).toBe("pipe")
    }

    expect(harnessCommand("opencode", ["--version"], { platform: "linux" }).options.shell).toBe(false)
  })

  for (const [harness, version] of [["claude", "2.1.296"], ["opencode", "opencode v2.0.27\n"]] as const) {
    it.effect(`checks only the selected ${harness} CLI and collects its version`, () => Effect.gen(function*() {
      const commands: string[] = []

      const spawner = ChildProcessSpawner.make((command) => Effect.sync(() => {
        if (!("command" in command)) throw new Error("unexpected pipeline")
        commands.push(`${command.command} ${command.args.join(" ")}`)

        return handle(version)
      }))

      expect(yield* inspectHarness(harness).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))).toBeUndefined()
      expect(commands).toEqual([`${harness} --version`])
    }))
  }

  it.effect("reports a spawn failure before configuration changes", () => Effect.gen(function*() {
    const spawner = ChildProcessSpawner.make(() => Effect.fail(new PlatformError.PlatformError(new PlatformError.BadArgument({
      module: "ChildProcess", method: "spawn", description: "could not execute command",
    }))))

    const error = yield* inspectHarness("opencode").pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip)
    expect(error.message).toContain("Could not start the opencode command")
    expect(error.message).toContain("configuration was not changed")
  }))

  it.effect("does not treat nonzero version output as verified", () => Effect.gen(function*() {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle("2.0.27", 1)))
    const opencodeError = yield* inspectHarness("opencode").pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip)
    expect(opencodeError.message).toContain("Check that opencode --version works")
    const error = yield* inspectHarness("claude").pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip)
    expect(error.message).toContain("Check that claude --version works")
  }))

  for (const code of [127, 9009]) {
    it.effect(`fails instead of offering an override when a shell cannot find the executable (${code})`, () => Effect.gen(function*() {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle("", code)))
      const error = yield* inspectHarness("opencode").pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.flip)

      expect(error.message).toContain("CLI on PATH")
      expect(error.message).toContain("configuration was not changed")
    }))
  }

  it.effect("preserves interruption and releases the process instead of returning a warning", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    let released = false

    const spawner = ChildProcessSpawner.make(() => Effect.acquireRelease(
      Deferred.succeed(entered, undefined).pipe(Effect.as({ ...handle(""), exitCode: Effect.never })),
      () => Effect.sync(() => { released = true }),
    ))

    const fiber = yield* inspectHarness("opencode").pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)

    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
    expect(released).toBe(true)
  }))

  for (const harness of ["opencode", "claude"] as const) {
    it.effect(`times out a hung ${harness} version check and releases its process`, () => Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let released = false

      const spawner = ChildProcessSpawner.make(() => Effect.acquireRelease(
        Deferred.succeed(entered, undefined).pipe(Effect.as({ ...handle(""), exitCode: Effect.never, isRunning: Effect.succeed(true) })),
        () => Effect.sync(() => { released = true }),
      ))

      const inspection = inspectHarness(harness).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

      const fiber = yield* (harness === "claude" ? inspection.pipe(Effect.flip, Effect.map((error) => error.message)) : inspection).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(fiber)).toContain("Could not verify")
      expect(released).toBe(true)
    }))
  }
})

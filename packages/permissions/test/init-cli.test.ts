import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as Terminal from "effect/Terminal"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as TestClock from "effect/testing/TestClock"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { parse } from "jsonc-parser"
import { executeInit } from "../src/init/cli.ts"
import type { InitFrontend } from "../src/init/cli.ts"
import { InitError, InitPlatform } from "../src/init/index.ts"
import type { InitHarness, InitPlan } from "../src/init/index.ts"
import { inspectHarness, opencodeCompatibilityWarning } from "../src/init/preflight.ts"
import { confirmInitWarning, layaPromptDefaults, promptLayaProvider } from "../src/init/prompt.ts"
import { enter, scriptedTerminal } from "./terminal-fixture.ts"

const frontend = <R>(
  prompt: InitFrontend<R>["prompt"],
  events: string[],
): InitFrontend<R> => ({
  prompt,
  showProgress: Effect.sync(() => { events.push("progress") }),
  showError: (message) => Effect.sync(() => { events.push(`error:${message}`) }),
  showResult: (result) => Effect.sync(() => { events.push(`result:${result.provider}`) }),
  confirmWarning: () => Effect.succeed(false),
  showCancelled: Effect.sync(() => { events.push("cancelled") }),
})

const planFor = (harnesses: readonly InitHarness[]): InitPlan => ({
  harnesses,
  provider: { provider: "zen", apiKey: Redacted.make("secret") },
})

const recordingPlatform = (events: string[], overrides: Partial<InitPlatform["Service"]> = {}) => InitPlatform.of({
  readConfig: () => Effect.sync(() => {
    events.push("read")

    return undefined
  }),
  inspectHarness: (harness) => Effect.sync(() => {
    events.push(`inspect:${harness}`)

    return undefined
  }),
  updateConfig: (_path, edit) => Effect.gen(function*() {
    yield* edit(undefined)
    events.push("write")
  }),
  installHarness: (harness) => Effect.sync(() => { events.push(`install:${harness}`) }),
  ...overrides,
})

const versionHandle = (version: string) => ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1), stdin: Sink.drain,
  stdout: Stream.make(new TextEncoder().encode(version)), stderr: Stream.empty, all: Stream.empty,
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)), isRunning: Effect.succeed(false), kill: () => Effect.void,
  getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
})

describe("Jevvy init command", () => {
  for (const harnesses of [["claude"], ["claude", "opencode"], ["opencode", "claude"]] as const) {
    it.effect(`inspects only selected CLIs in plan order before any mutation (${harnesses.join(", ")})`, () => Effect.gen(function*() {
      const events: string[] = []

      const ui = frontend(() => Effect.sync(() => {
        events.push("prompt")

        return planFor(harnesses)
      }), events)

      const code = yield* executeInit(ui, "preview.jsonc").pipe(Effect.provideService(InitPlatform, recordingPlatform(events)))

      expect(code).toBe(0)
      expect(events).toEqual(["read", "prompt", ...harnesses.map((harness) => `inspect:${harness}`), "progress", "write", ...harnesses.map((harness) => `install:${harness}`), "result:zen"])
    }))
  }

  for (const version of ["2.0.26", "unrecognized"]) {
    it.effect(`declines ${version} on Enter without writes or installs`, () => Effect.gen(function*() {
      const events: string[] = []
      const terminal = scriptedTerminal([[enter]])

      const ui = {
        ...frontend(() => Effect.succeed(planFor(["opencode", "claude"])), events),
        confirmWarning: confirmInitWarning,
      }

      const platform = recordingPlatform(events, {
        inspectHarness: (harness) => Effect.sync(() => {
          events.push(`inspect:${harness}`)

          return opencodeCompatibilityWarning(version)
        }),
      })

      const code = yield* executeInit(ui, "preview.jsonc").pipe(
        Effect.provideService(InitPlatform, platform),
        Effect.provideService(Terminal.Terminal, terminal.terminal),
        Effect.provide(NodeServices.layer),
      )

      expect(code).toBe(0)
      expect(events).toEqual(["read", "inspect:opencode"])
      expect(terminal.output()).toContain("Continue with this OpenCode CLI anyway?")
      expect(terminal.output()).toContain("Jevvy Permissions setup cancelled")
    }))

    it.effect(`explicit override for ${version} installs only the current unpinned plugin`, () => Effect.gen(function*() {
      const events: string[] = []

      const spawner = ChildProcessSpawner.make((command) => Effect.sync(() => {
        if (!("command" in command)) throw new Error("unexpected pipeline")
        events.push(`command:${command.command} ${command.args.join(" ")}`)

        return versionHandle(command.args[0] === "--version" ? version : "")
      }))

      const real = yield* InitPlatform.pipe(Effect.provide(InitPlatform.layer.pipe(Layer.provide([
        FileSystem.layerNoop({}), Path.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ]))))

      const platform = recordingPlatform(events, { inspectHarness: real.inspectHarness, installHarness: real.installHarness })

      const ui = {
        ...frontend(() => Effect.succeed(planFor(["opencode"])), events),
        confirmWarning: (warning: string) => Effect.sync(() => {
          expect(warning).toBe(opencodeCompatibilityWarning(version))
          events.push("override")

          return true
        }),
      }

      const code = yield* executeInit(ui, "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

      expect(code).toBe(0)
      expect(events).toEqual(["read", "command:opencode --version", "override", "progress", "write", "command:opencode plugin add @jevvy/permissions", "result:zen"])
    }))
  }

  it.effect("cancels at the compatibility choice without writes or installs", () => Effect.gen(function*() {
    const events: string[] = []

    const ui = {
      ...frontend(() => Effect.succeed(planFor(["opencode", "claude"])), events),
      confirmWarning: () => Effect.fail(new Terminal.QuitError()),
    }

    const platform = recordingPlatform(events, { inspectHarness: () => Effect.succeed("compatibility warning") })
    const code = yield* executeInit(ui, "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(0)
    expect(events).toEqual(["read", "cancelled"])
  }))

  it.effect("reports a selected CLI failure before writing even when an earlier CLI passed", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = recordingPlatform(events, {
      inspectHarness: (harness) => Effect.gen(function*() {
        events.push(`inspect:${harness}`)

        if (harness === "claude") return yield* new InitError({ operation: "preflight", message: "Install the Claude Code CLI" })

        return undefined
      }),
    })

    const code = yield* executeInit(frontend(() => Effect.succeed(planFor(["opencode", "claude"])), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(1)
    expect(events).toEqual(["read", "inspect:opencode", "inspect:claude", "error:Install the Claude Code CLI"])
  }))

  it.effect("leaves interruption as control flow without warnings, errors, or mutations", () => Effect.gen(function*() {
    const events: string[] = []
    const platform = recordingPlatform(events, { inspectHarness: () => Effect.interrupt })

    const ui = {
      ...frontend(() => Effect.succeed(planFor(["opencode"])), events),
      confirmWarning: () => Effect.die("interruption must not become a warning"),
    }

    const exit = yield* executeInit(ui, "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform), Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
    expect(events).toEqual(["read"])
  }))

  it.effect("releases a hung version process at five seconds before asking or writing", () => Effect.gen(function*() {
    const events: string[] = []
    const entered = yield* Deferred.make<void>()

    const spawner = ChildProcessSpawner.make(() => Effect.acquireRelease(
      Deferred.succeed(entered, undefined).pipe(Effect.as({ ...versionHandle(""), exitCode: Effect.never })),
      () => Effect.sync(() => { events.push("released") }),
    ))

    const platform = recordingPlatform(events, {
      inspectHarness: (harness) => inspectHarness(harness).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) => new InitError({ operation: "preflight", message: error.message })),
      ),
    })

    const ui = {
      ...frontend(() => Effect.succeed(planFor(["opencode"])), events),
      confirmWarning: () => Effect.sync(() => {
        events.push("override")

        return true
      }),
    }

    const fiber = yield* executeInit(ui, "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform), Effect.forkChild)
    yield* Deferred.await(entered)
    yield* TestClock.adjust("4999 millis")
    expect(events).toEqual(["read"])
    yield* TestClock.adjust("1 millis")

    expect(yield* Fiber.join(fiber)).toBe(0)
    expect(events).toEqual(["read", "released", "override", "progress", "write", "install:opencode", "result:zen"])
  }))

  it.effect("reads existing config for prompt defaults but makes no changes on cancellation", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      inspectHarness: () => Effect.die("preflight should not run"),
      readConfig: () => Effect.sync(() => {
        events.push("read")

        return '{ "provider": "laya" }'
      }),
      updateConfig: () => Effect.die("updateConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(
      frontend((_path, existing) => Effect.sync(() => {
        expect(existing).toBe('{ "provider": "laya" }')

        return undefined
      }), events),
      "/home/user/.config/jevvy/jevvy.jsonc",
    ).pipe(Effect.provide(platform))

    expect(code).toBe(0)
    expect(events).toEqual(["read"])
  }))

  it.effect("reports unreadable config before showing a setup plan", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      inspectHarness: () => Effect.die("preflight should not run"),
      readConfig: () => new InitError({ operation: "read-config", message: "Jevvy configuration could not be read" }),
      updateConfig: () => Effect.die("updateConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(frontend(() => Effect.die("prompt should not run"), events), "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(platform))

    expect(code).toBe(1)
    expect(events).toEqual(["error:Jevvy configuration could not be read"])
  }))

  it.effect("reports initialization failures without showing success", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      inspectHarness: () => Effect.succeed(undefined),
      readConfig: () => Effect.succeed(undefined),
      updateConfig: () => new InitError({
        operation: "write-config",
        message: "configuration is read-only",
      }),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(
      frontend(() => Effect.succeed({
        harnesses: ["opencode"],
        provider: { provider: "zen", apiKey: Redacted.make("secret") },
      }), events),
      "/home/user/.config/jevvy/jevvy.jsonc",
    ).pipe(Effect.provide(platform))

    expect(code).toBe(1)
    expect(events).toEqual(["progress", "error:configuration is read-only"])
  }))

  it.effect("prefills a calibrated Laya rerun and preserves its policy", () => Effect.gen(function*() {
    const events: string[] = []

    const policy = { checkpoint: "multilingual", questions: {
      harmful: { type: "noul", instructions: "Harmful?", threshold: 0.15 },
    } }

    const existing = JSON.stringify({
      provider: "laya",
      providers: { laya: { endpoint: "https://laya.example.com/v1/systemone", model: "multilingual", policy } },
    })

    let written = ""

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      inspectHarness: () => Effect.succeed(undefined),
      readConfig: () => Effect.sync(() => {
        events.push("read")

        return existing
      }),
      updateConfig: (_path, edit) => Effect.gen(function*() {
        events.push("read")
        const content = yield* edit(existing)
        written = content
        events.push("write")
      }),
      installHarness: () => Effect.sync(() => { events.push("install") }),
    }))

    const code = yield* executeInit(frontend((_path, raw) => Effect.gen(function*() {
      const defaults = layaPromptDefaults(raw)

      const provider = yield* promptLayaProvider({
        text: ({ default: value }) => Effect.succeed(value ?? ""),
        select: ({ choices }) => Effect.succeed(choices[0]?.value ?? "english"),
        confirm: () => Effect.succeed(false),
        password: () => Effect.succeed(Redacted.make("unused")),
      }, defaults)

      return { harnesses: ["opencode"], provider }
    }), events), "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(platform), Effect.provide(NodeServices.layer))

    expect(code).toBe(0)
    expect(parse(written).providers.laya.policy).toEqual(policy)
    expect(events).toEqual(["read", "progress", "read", "write", "install", "result:laya"])
  }))

  it.effect("preserves the saved config when an installer fails after preflight", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = recordingPlatform(events, {
      installHarness: () => new InitError({ operation: "install-opencode", message: "installer failed" }),
    })

    const code = yield* executeInit(frontend(() => Effect.succeed(planFor(["opencode"])), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(1)
    expect(events).toEqual(["read", "inspect:opencode", "progress", "write", "error:installer failed"])
  }))

  it.effect("treats terminal cancellation as a clean exit without writes or installs", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.succeed(undefined),
      inspectHarness: () => Effect.die("preflight should not run"),
      updateConfig: () => Effect.die("updateConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(frontend(() => Effect.fail(new Terminal.QuitError()), events), "preview.jsonc").pipe(Effect.provide(platform))

    expect(code).toBe(0)
    expect(events).toEqual(["cancelled"])
  }))
})

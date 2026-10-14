import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Redacted from "effect/Redacted"
import * as Terminal from "effect/Terminal"
import { parse } from "jsonc-parser"
import { executeInit } from "../src/init/cli.ts"
import type { InitFrontend } from "../src/init/cli.ts"
import { InitError, InitPlatform } from "../src/init/index.ts"
import type { InitHarness, InitPlan } from "../src/init/index.ts"
import { layaPromptDefaults, promptLayaProvider } from "../src/init/prompt.ts"

const frontend = <R>(prompt: InitFrontend<R>["prompt"], events: string[]): InitFrontend<R> => ({
  prompt,
  showProgress: Effect.sync(() => { events.push("progress") }),
  showError: (message) => Effect.sync(() => { events.push(`error:${message}`) }),
  showResult: (result) => Effect.sync(() => { events.push(`result:${result.provider}`) }),
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
  updateConfig: (_path, edit) => Effect.gen(function*() {
    yield* edit(undefined)
    events.push("write")
  }),
  installHarness: (harness) => Effect.sync(() => { events.push(`install:${harness}`) }),
  ...overrides,
})

describe("Jevvy init command", () => {
  for (const harnesses of [["claude"], ["claude", "opencode"], ["opencode", "claude"]] as const) {
    it.effect(`saves before installing selected harnesses in plan order (${harnesses.join(", ")})`, () => Effect.gen(function*() {
      const events: string[] = []

      const ui = frontend(() => Effect.sync(() => {
        events.push("prompt")

        return planFor(harnesses)
      }), events)

      const code = yield* executeInit(ui, "preview.jsonc").pipe(Effect.provideService(InitPlatform, recordingPlatform(events)))

      expect(code).toBe(0)
      expect(events).toEqual(["read", "prompt", "progress", "write", ...harnesses.map((harness) => `install:${harness}`), "result:zen"])
    }))
  }

  it.effect("reads config for defaults without changing it on cancellation", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = recordingPlatform(events, {
      readConfig: () => Effect.sync(() => {
        events.push("read")

        return '{ "provider": "laya" }'
      }),
      updateConfig: () => Effect.die("updateConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    })

    const code = yield* executeInit(frontend((_path, existing) => Effect.sync(() => {
      expect(existing).toBe('{ "provider": "laya" }')

      return undefined
    }), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(0)
    expect(events).toEqual(["read"])
  }))

  it.effect("reports unreadable config before showing a setup plan", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = recordingPlatform(events, {
      readConfig: () => new InitError({ operation: "read-config", message: "Jevvy configuration could not be read" }),
      updateConfig: () => Effect.die("updateConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    })

    const code = yield* executeInit(frontend(() => Effect.die("prompt should not run"), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(1)
    expect(events).toEqual(["error:Jevvy configuration could not be read"])
  }))

  it.effect("reports initialization failures without showing success", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = recordingPlatform(events, {
      updateConfig: () => new InitError({ operation: "write-config", message: "configuration is read-only" }),
      installHarness: () => Effect.die("installHarness should not run"),
    })

    const code = yield* executeInit(frontend(() => Effect.succeed(planFor(["opencode"])), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(1)
    expect(events).toEqual(["read", "progress", "error:configuration is read-only"])
  }))

  it.effect("preserves the saved config when an installer fails", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = recordingPlatform(events, {
      installHarness: () => new InitError({ operation: "install-opencode", message: "installer failed" }),
    })

    const code = yield* executeInit(frontend(() => Effect.succeed(planFor(["opencode"])), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform))

    expect(code).toBe(1)
    expect(events).toEqual(["read", "progress", "write", "error:installer failed"])
  }))

  it.effect("prefills a calibrated Laya rerun and preserves its policy", () => Effect.gen(function*() {
    const events: string[] = []

    const policy = { checkpoint: "multilingual", questions: {
      harmful: { type: "noul", instructions: "Harmful?", threshold: 0.15 },
    } }

    const existing = JSON.stringify({
      provider: "laya", providers: { laya: { endpoint: "https://laya.example.com/v1/systemone", model: "multilingual", policy } },
    })

    let written = ""

    const platform = recordingPlatform(events, {
      readConfig: () => Effect.succeed(existing),
      updateConfig: (_path, edit) => Effect.gen(function*() {
        written = yield* edit(existing)
        events.push("write")
      }),
    })

    const code = yield* executeInit(frontend((_path, raw) => Effect.gen(function*() {
      const provider = yield* promptLayaProvider({
        text: ({ default: value }) => Effect.succeed(value ?? ""),
        select: ({ choices }) => Effect.succeed(choices[0]?.value ?? "english"),
        confirm: () => Effect.succeed(false),
        password: () => Effect.succeed(Redacted.make("unused")),
      }, layaPromptDefaults(raw))

      return { harnesses: ["opencode"], provider }
    }), events), "preview.jsonc").pipe(Effect.provideService(InitPlatform, platform), Effect.provide(NodeServices.layer))

    expect(code).toBe(0)
    expect(parse(written).providers.laya.policy).toEqual(policy)
    expect(events).toEqual(["progress", "write", "install:opencode", "result:laya"])
  }))

  it.effect("treats terminal cancellation as a clean exit without writes or installs", () => Effect.gen(function*() {
    const events: string[] = []

    const code = yield* executeInit(frontend(() => Effect.fail(new Terminal.QuitError()), events), "preview.jsonc").pipe(
      Effect.provideService(InitPlatform, recordingPlatform(events)),
    )

    expect(code).toBe(0)
    expect(events).toEqual(["read", "cancelled"])
  }))

  it.effect("leaves interruption as control flow without errors or mutations", () => Effect.gen(function*() {
    const events: string[] = []

    const exit = yield* executeInit(frontend(() => Effect.interrupt, events), "preview.jsonc").pipe(
      Effect.provideService(InitPlatform, recordingPlatform(events)), Effect.exit,
    )

    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
    expect(events).toEqual(["read"])
  }))
})

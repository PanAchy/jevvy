import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { parse } from "jsonc-parser"
import { executeInit } from "../src/init/cli.ts"
import type { InitFrontend } from "../src/init/cli.ts"
import { InitError, InitPlatform } from "../src/init/index.ts"
import { layaPromptDefaults, promptLayaProvider } from "../src/init/prompt.ts"

const frontend = (
  prompt: InitFrontend["prompt"],
  events: string[],
): InitFrontend => ({
  prompt,
  showProgress: () => events.push("progress"),
  showError: (message) => events.push(`error:${message}`),
  showResult: (result) => events.push(`result:${result.provider}`),
})

describe("Jevvy init command", () => {
  it.effect("reads existing config for prompt defaults but makes no changes on cancellation", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.sync(() => {
        events.push("read")

        return '{ "provider": "laya" }'
      }),
      writeConfig: () => Effect.die("writeConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(
      frontend(async (_path, existing) => {
        expect(existing).toBe('{ "provider": "laya" }')

        return undefined
      }, events),
      "/home/user/.config/jevvy/jevvy.jsonc",
    ).pipe(Effect.provide(platform))

    expect(code).toBe(0)
    expect(events).toEqual(["read"])
  }))

  it.effect("reports unreadable config before showing a setup plan", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => new InitError({ operation: "read-config", message: "Jevvy configuration could not be read" }),
      writeConfig: () => Effect.die("writeConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(frontend(async () => {
      throw new Error("prompt should not run")
    }, events), "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(platform))

    expect(code).toBe(1)
    expect(events).toEqual(["error:Jevvy configuration could not be read"])
  }))

  it.effect("reports initialization failures without showing success", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.succeed(undefined),
      writeConfig: () => new InitError({
        operation: "write-config",
        message: "configuration is read-only",
      }),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(
      frontend(async () => ({
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
      readConfig: () => Effect.sync(() => {
        events.push("read")

        return existing
      }),
      writeConfig: (_path, content) => Effect.sync(() => {
        written = content
        events.push("write")
      }),
      installHarness: () => Effect.sync(() => { events.push("install") }),
    }))

    const code = yield* executeInit(frontend(async (_path, raw) => {
      const defaults = layaPromptDefaults(raw)

      const provider = await promptLayaProvider({
        text: async ({ initialValue }) => initialValue ?? "",
        select: async ({ initialValue }) => initialValue ?? "english",
        confirm: async () => false,
        password: async () => "unused",
      }, defaults)

      return provider === undefined ? undefined : { harnesses: ["opencode"], provider }
    }, events), "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(platform))

    expect(code).toBe(0)
    expect(parse(written).providers.laya.policy).toEqual(policy)
    expect(events).toEqual(["read", "progress", "read", "write", "install", "result:laya"])
  }))
})

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { executeInit } from "../src/init/cli.ts"
import type { InitFrontend } from "../src/init/cli.ts"
import { InitError, InitPlatform } from "../src/init/index.ts"

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
  it.effect("stops without platform effects when the user cancels", () => Effect.gen(function*() {
    const events: string[] = []

    const platform = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.die("readConfig should not run"),
      writeConfig: () => Effect.die("writeConfig should not run"),
      installHarness: () => Effect.die("installHarness should not run"),
    }))

    const code = yield* executeInit(
      frontend(async () => undefined, events),
      "/home/user/.config/jevvy/jevvy.jsonc",
    ).pipe(Effect.provide(platform))

    expect(code).toBe(0)
    expect(events).toEqual([])
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
})

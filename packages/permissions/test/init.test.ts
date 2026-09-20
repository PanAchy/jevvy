import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { parse } from "jsonc-parser"
import {
  initializeJevvy,
  InitPlatform,
  renderJevvyConfig,
} from "../src/init/index.ts"
import {
  initPlanSummary,
  openCodeZenApiKeyPrompt,
  openCodeZenAuthenticationPrompt,
} from "../src/init/prompt.ts"

describe("Jevvy initializer", () => {
  it("formats provider and harness names for confirmation", () => {
    expect(initPlanSummary({
      harnesses: ["opencode"],
      provider: { provider: "typesafe", apiKey: Redacted.make("secret") },
    }, "/home/user/.config/jevvy/jevvy.jsonc")).toBe([
      "Harnesses: OpenCode",
      "Provider: TypeSafe AI",
      "Configuration: /home/user/.config/jevvy/jevvy.jsonc",
      "Credential: stored securely in config",
    ].join("\n"))
  })

  it("describes OpenCode Zen login credentials without exposing a secret", () => {
    expect(initPlanSummary({
      harnesses: ["opencode"],
      provider: { provider: "zen" },
    }, "/home/user/.config/jevvy/jevvy.jsonc")).toContain(
      "Credential: OpenCode login (OAuth or API key)",
    )
  })

  it("explains both OpenCode Zen credential sources", () => {
    expect(openCodeZenAuthenticationPrompt).toEqual({
      message: "How should OpenCode Zen authenticate?",
      options: [
        {
          value: "opencode",
          label: "Use existing OpenCode login",
          hint: "OAuth or API key configured in OpenCode",
        },
        {
          value: "jevvy",
          label: "Enter an OpenCode Zen API key",
          hint: "store it securely in Jevvy config",
        },
      ],
    })
    expect(openCodeZenApiKeyPrompt).toBe("Enter your OpenCode Zen API key")
  })


  it.effect("renders a new custom provider configuration", () => Effect.gen(function*() {
    const rendered = yield* renderJevvyConfig(undefined, {
      provider: "custom",
      endpoint: "https://api.aimlapi.com/v1/decisions",
      model: "typesafe/jev",
      apiKey: Redacted.make("secret"),
    })

    expect(parse(rendered)).toEqual({
      $schema: "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
      provider: "custom",
      providers: {
        custom: {
          endpoint: "https://api.aimlapi.com/v1/decisions",
          model: "typesafe/jev",
          apiKey: "secret",
        },
      },
    })
  }))

  it.effect("preserves unrelated JSONC configuration while changing providers", () => Effect.gen(function*() {
    const existing = `{
      // Keep this policy.
      "provider": "typesafe",
      "providers": { "typesafe": { "apiKey": "old" } },
      "permissions": {
        "questions": {
          "safe": {
            "type": "noul",
            "instructions": "Risky?",
            "threshold": 0.1
          }
        }
      }
    }`

    const rendered = yield* renderJevvyConfig(existing, {
      provider: "openrouter",
      apiKey: Redacted.make("new"),
    })

    const document = parse(rendered)

    expect(rendered).toContain("// Keep this policy.")
    expect(document.provider).toBe("openrouter")
    expect(document.providers.openrouter).toEqual({ apiKey: "new" })
    expect(document.permissions.questions.safe.instructions).toBe("Risky?")
    expect(document.permissions.questions.safe.threshold).toBe(0.1)
  }))

  it.effect.each(["[]", "null", '"text"', "42"])(
    "rejects a non-object JSONC root: %s",
    (existing) => Effect.gen(function*() {
      const error = yield* renderJevvyConfig(existing, { provider: "zen" }).pipe(Effect.flip)

      expect(error).toMatchObject({
        operation: "parse-config",
        message: "Existing jevvy.jsonc must contain an object",
      })
    }),
  )

  it.effect("writes configuration before installing every selected harness", () => Effect.gen(function*() {
    const events: string[] = []

    const layer = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.succeed(undefined),
      writeConfig: (_path, content) => Effect.sync(() => {
        events.push(`write:${parse(content).provider}`)
      }),
      installHarness: (harness) => Effect.sync(() => {
        events.push(`install:${harness}`)
      }),
    }))

    const result = yield* initializeJevvy({
      harnesses: ["opencode"],
      provider: { provider: "zen" },
    }, "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(layer))

    expect(events).toEqual(["write:zen", "install:opencode"])
    expect(result).toEqual({
      configPath: "/home/user/.config/jevvy/jevvy.jsonc",
      harnesses: ["opencode"],
      provider: "zen",
      needsOpenCodeLogin: true,
    })
  }))

  it.effect("writes credential-bearing configuration with mode 0600", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "jevvy-init-"))),
      (directory) => Effect.gen(function*() {
        const path = join(directory, "jevvy.jsonc")
        const platform = yield* InitPlatform

        yield* platform.writeConfig(path, "{\"apiKey\":\"secret\"}\n")
        expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600)
      }).pipe(
        Effect.provide(InitPlatform.layer),
        Effect.provide(NodeServices.layer),
      ),
      (directory) => Effect.promise(() => rm(directory, { recursive: true })),
    ))
})

import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Redacted } from "effect"
import { loadJevvyConfig } from "../src/config.ts"

const customQuestions = {
  harmful: {
    type: "noul" as const,
    instructions: "Could this action cause harm?",
    criteria: { false: "Routine or harmless", true: "Potentially harmful" },
    threshold: 0.25,
  },
}

const customPolicyConfig = {
  $schema: "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  provider: "typesafe",
  permissions: { questions: customQuestions },
}

const noEnvironment = ConfigProvider.fromUnknown({})

const load = (path: string, environment = noEnvironment) => loadJevvyConfig(path, environment)

const withConfigFile = <A, E, R>(
  raw: string,
  use: (path: string) => Effect.Effect<A, E, R>,
  mode?: number,
): Effect.Effect<A, E, R> => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevvy-config-"))
    const path = join(directory, "jevvy.jsonc")

    await writeFile(path, raw)

    if (mode !== undefined) await chmod(path, mode)

    return { directory, path }
  }),
  ({ path }) => use(path),
  ({ directory }) => Effect.promise(() => rm(directory, { recursive: true })),
)

describe("Jevvy configuration", () => {
  it.effect("loads a complete custom question set", () => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify(customPolicyConfig), load)

    expect(config).toEqual({
      kind: "custom-policy",
      selection: { provider: "typesafe", apiKey: undefined },
      questions: customQuestions,
    })
  }))

  it.effect.each([
    "not json",
    JSON.stringify({}),
    JSON.stringify({ provider: "auto" }),
    JSON.stringify({ provider: "other" }),
    JSON.stringify({ ...customPolicyConfig, unknown: true }),
    JSON.stringify({ provider: "typesafe", permissions: { questions: {} } }),
    JSON.stringify({
      provider: "typesafe",
      permissions: { questions: { "": customQuestions.harmful } },
    }),
    JSON.stringify({
      provider: "typesafe",
      permissions: {
        questions: {
          harmful: {
            type: "noul",
            instructions: "Could this cause harm?",
            threshold: 2,
          },
        },
      },
    }),
    JSON.stringify({
      provider: "typesafe",
      permissions: {
        questions: {
          harmful: { type: "noul", instructions: "Could this cause harm?" },
        },
      },
    }),
    JSON.stringify({
      provider: "custom",
      providers: { custom: { endpoint: "file:///tmp/laya", model: "laya" } },
      permissions: { questions: customQuestions },
    }),
  ])("rejects invalid explicit configuration", (raw) => Effect.gen(function*() {
    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("stays unconfigured when the global file is absent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "jevvy-config-"))),
      (directory) => Effect.gen(function*() {
        expect(yield* load(join(directory, "missing.json"))).toEqual({ kind: "unconfigured" })
      }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true })),
    ))

  it.effect("loads the explicitly selected provider and prefers its global key", () => Effect.gen(function*() {
    const environment = ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "environment-key" })

    const raw = JSON.stringify({
      provider: "typesafe",
      providers: { typesafe: { apiKey: "file-key" } },
    })

    const config = yield* withConfigFile(raw, (path) => load(path, environment), 0o600)

    expect(config.kind).toBe("shipped-policy")

    if (config.kind !== "shipped-policy") return

    expect(config.selection.provider).toBe("typesafe")
    expect(config.selection.apiKey).toBeDefined()

    if (config.selection.apiKey === undefined) return

    expect(Redacted.value(config.selection.apiKey)).toBe("file-key")
  }))

  it.effect("uses the selected provider's native environment key when the global file has none", () =>
    Effect.gen(function*() {
      const environment = ConfigProvider.fromUnknown({ OPENROUTER_API_KEY: "environment-key" })
      const raw = JSON.stringify({ provider: "openrouter" })
      const config = yield* withConfigFile(raw, (path) => load(path, environment))

      expect(config.kind).toBe("shipped-policy")

      if (config.kind !== "shipped-policy") return

      expect(config.selection.provider).toBe("openrouter")
      expect(config.selection.apiKey).toBeDefined()

      if (config.selection.apiKey === undefined) return

      expect(Redacted.value(config.selection.apiKey)).toBe("environment-key")
    }))

  it.effect("loads an unauthenticated custom System One endpoint with custom questions", () =>
    Effect.gen(function*() {
      const raw = JSON.stringify({
        provider: "custom",
        providers: {
          custom: {
            endpoint: "http://127.0.0.1:8080/v1/decisions",
            model: "laya-typed-decisions",
          },
        },
        permissions: { questions: customQuestions },
      })

      expect(yield* withConfigFile(raw, load)).toEqual({
        kind: "custom-policy",
        selection: {
          provider: "custom",
          endpoint: "http://127.0.0.1:8080/v1/decisions",
          model: "laya-typed-decisions",
          apiKey: undefined,
        },
        questions: customQuestions,
      })
    }))

  it.effect("uses shipped questions when a custom provider does not configure questions", () =>
    Effect.gen(function*() {
      const raw = JSON.stringify({
        provider: "custom",
        providers: {
          custom: { endpoint: "https://api.aimlapi.com/v1/decisions", model: "typesafe/jev" },
        },
      })

      expect(yield* withConfigFile(raw, load)).toEqual({
        kind: "shipped-policy",
        selection: {
          provider: "custom",
          endpoint: "https://api.aimlapi.com/v1/decisions",
          model: "typesafe/jev",
          apiKey: undefined,
        },
      })
    }))

  it.effect("accepts comments and trailing commas", () => Effect.gen(function*() {
    const raw = `{
      // Select one provider explicitly.
      "provider": "typesafe",
    }`

    expect(yield* withConfigFile(raw, load)).toEqual({
      kind: "shipped-policy",
      selection: { provider: "typesafe", apiKey: undefined },
    })
  }))

  it.effect.each([0o644, 0o400])("secures a credential file with mode %s", (mode) => {
    if (process.platform === "win32") return Effect.void

    const raw = JSON.stringify({ provider: "zen", providers: { zen: { apiKey: "file-key" } } })

    return withConfigFile(raw, (path) => Effect.gen(function*() {
      const config = yield* load(path)
      const info = yield* Effect.promise(() => stat(path))

      expect(config.kind).toBe("shipped-policy")
      expect(info.mode & 0o777).toBe(0o600)
    }), mode)
  })
})

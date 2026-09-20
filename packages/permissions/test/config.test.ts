import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { loadJevvyConfig } from "../src/config.ts"

const customConfig = {
  $schema: "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  permissions: {
    questions: {
      harmless: {
        type: "noul",
        instructions: "How likely is this action harmless?",
        criteria: { false: "Harmful", true: "Harmless" },
        threshold: { direction: "atLeast", value: 0.99 },
      },
    },
  },
}

const noEnvironment = ConfigProvider.fromUnknown({})

const load = (path: string, environment = noEnvironment) =>
  Effect.runPromise(loadJevvyConfig(path, environment))

const withConfigFile = async <A>(raw: string, use: (path: string) => Promise<A>, mode?: number): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "jevvy-config-"))
  const path = `${directory}/jevvy.jsonc`

  try {
    await writeFile(path, raw)

    if (mode !== undefined) await chmod(path, mode)

    return await use(path)
  } finally {
    await rm(directory, { recursive: true })
  }
}

describe("Jevvy configuration", () => {
  it("loads a complete custom question set", async () => {
    await expect(withConfigFile(JSON.stringify(customConfig), load)).resolves.toEqual({
      kind: "custom",
      provider: "auto",
      apiKeys: {},
      questions: customConfig.permissions.questions,
    })
  })

  it.each([
    "not json",
    JSON.stringify({ permissions: { questions: {} } }),
    JSON.stringify({ provider: "other" }),
    JSON.stringify({ ...customConfig, unknown: true }),
    JSON.stringify({ permissions: { questions: { "": customConfig.permissions.questions.harmless } } }),
    JSON.stringify({
      permissions: {
        questions: {
          harmful: {
            type: "noul",
            instructions: "Harmful?",
            threshold: { direction: "atMost", value: 2 },
          },
        },
      },
    }),
  ])("rejects invalid explicit configuration", async (raw) => {
    await expect(withConfigFile(raw, load)).resolves.toMatchObject({ kind: "invalid" })
  })

  it("uses calibrated defaults when the global file is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevvy-config-"))

    try {
      await expect(load(`${directory}/missing.json`)).resolves.toEqual({
        kind: "default",
        provider: "auto",
        apiKeys: {},
      })
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it("loads redacted provider keys from the global file before native environment keys", async () => {
    const environment = ConfigProvider.fromEnvRecord({
      OPENCODE_API_KEY: "environment-zen-key",
      TYPESAFE_API_KEY: "environment-typesafe-key",
      OPENROUTER_API_KEY: "environment-openrouter-key",
      AI_GATEWAY_API_KEY: "environment-vercel-key",
    })

    const raw = JSON.stringify({
      providers: {
        zen: { apiKey: "file-zen-key" },
        typesafe: { apiKey: "file-typesafe-key" },
        openrouter: { apiKey: "file-openrouter-key" },
        vercel: { apiKey: "file-vercel-key" },
      },
    })

    const config = await withConfigFile(raw, (path) => load(path, environment), 0o600)

    expect(config.kind).toBe("default")

    if (config.kind !== "default") return

    const zen = config.apiKeys.zen
    const typesafe = config.apiKeys.typesafe
    const openrouter = config.apiKeys.openrouter
    const vercel = config.apiKeys.vercel

    if (zen === undefined || typesafe === undefined || openrouter === undefined || vercel === undefined) {
      throw new Error("expected all provider keys")
    }

    expect(Redacted.value(zen)).toBe("file-zen-key")
    expect(Redacted.value(typesafe)).toBe("file-typesafe-key")
    expect(Redacted.value(openrouter)).toBe("file-openrouter-key")
    expect(Redacted.value(vercel)).toBe("file-vercel-key")
  })

  it("loads the provider preference from the global file", async () => {
    const raw = JSON.stringify({ provider: "vercel" })

    await expect(withConfigFile(raw, load)).resolves.toEqual({
      kind: "default",
      provider: "vercel",
      apiKeys: {},
    })
  })

  it("accepts comments and trailing commas", async () => {
    const raw = `{
      // Keep TypeSafe available for policy calibration.
      "provider": "typesafe",
    }`

    await expect(withConfigFile(raw, load)).resolves.toEqual({
      kind: "default",
      provider: "typesafe",
      apiKeys: {},
    })
  })

  it("uses provider-native environment keys when the global file has none", async () => {
    const environment = ConfigProvider.fromEnvRecord({
      OPENCODE_API_KEY: "environment-zen-key",
      TYPESAFE_API_KEY: "environment-typesafe-key",
      OPENROUTER_API_KEY: "environment-openrouter-key",
      AI_GATEWAY_API_KEY: "environment-vercel-key",
    })

    const directory = await mkdtemp(join(tmpdir(), "jevvy-config-"))

    try {
      const config = await load(`${directory}/missing.json`, environment)

      expect(config.kind).toBe("default")

      if (config.kind !== "default") return

      const zen = config.apiKeys.zen
      const typesafe = config.apiKeys.typesafe
      const openrouter = config.apiKeys.openrouter
      const vercel = config.apiKeys.vercel

      if (zen === undefined || typesafe === undefined || openrouter === undefined || vercel === undefined) {
        throw new Error("expected all provider keys")
      }

      expect(Redacted.value(zen)).toBe("environment-zen-key")
      expect(Redacted.value(typesafe)).toBe("environment-typesafe-key")
      expect(Redacted.value(openrouter)).toBe("environment-openrouter-key")
      expect(Redacted.value(vercel)).toBe("environment-vercel-key")
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it.runIf(process.platform !== "win32").each([0o644, 0o400])(
    "secures a credential file with mode %s",
    async (mode) => {
      const raw = JSON.stringify({ providers: { zen: { apiKey: "file-key" } } })

      await withConfigFile(raw, async (path) => {
        const config = await load(path)
        const info = await stat(path)

        expect(config.kind).toBe("default")
        expect(info.mode & 0o777).toBe(0o600)
      }, mode)
    },
  )
})

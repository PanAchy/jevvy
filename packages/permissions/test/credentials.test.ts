import { Effect, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import {
  missingConfigurationMessage,
  missingCredentialMessage,
  OPENCODE_INTEGRATION,
  selectOpenCodeProvider,
} from "../src/opencode/credentials.ts"
import type { JevClient } from "../src/core.ts"
import type { CredentialPorts, StoredCredential } from "../src/opencode/credentials.ts"

interface Connection {
  readonly id: string
  readonly kind: "credential" | "env"
  readonly envName?: string
}

const describeConnection = (connection: Connection) => connection

const openCodeClient = (): JevClient => ({ evaluate: () => Effect.die("not called") })

const ports = (options: {
  readonly active?: Readonly<Record<string, Connection>>
  readonly stored?: Readonly<Record<string, StoredCredential>>
  readonly env?: Readonly<Record<string, string>>
} = {}): CredentialPorts<Connection> => ({
  activeIntegration: (id) => Effect.succeed(options.active?.[id]),
  resolveIntegration: (connection) => Effect.succeed(options.stored?.[connection.id]),
  readEnv: (name) => options.env?.[name],
})

describe("OpenCode credential resolution", () => {
  it("explains assisted and manual setup when no provider is configured", () => {
    const path = "/home/user/.config/jevvy/jevvy.jsonc"

    expect(missingConfigurationMessage(path)).toBe(
      `Jevvy cannot start because no provider is configured. Run "npx @jevvy/permissions init", or create ${path} manually. OpenCode's remaining permission flow remains unchanged.`,
    )
  })

  it.each([
    ["zen", "OpenCode Zen", "opencode auth login opencode", "OPENCODE_API_KEY", "providers.zen.apiKey"],
    ["typesafe", "TypeSafe AI", undefined, "TYPESAFE_API_KEY", "providers.typesafe.apiKey"],
    ["openrouter", "OpenRouter", undefined, "OPENROUTER_API_KEY", "providers.openrouter.apiKey"],
    ["vercel", "Vercel AI Gateway", undefined, "AI_GATEWAY_API_KEY", "providers.vercel.apiKey"],
  ] as const)("explains how to configure missing %s credentials", (provider, label, login, environment, config) => {
    const message = missingCredentialMessage(provider, "/home/user/.config/jevvy/jevvy.jsonc")

    expect(message).toContain(label)
    expect(message).toContain(environment)
    expect(message).toContain(config)
    expect(message).toContain("npx @jevvy/permissions init")
    expect(message).toContain("OpenCode's remaining permission flow remains unchanged")
    expect(message).toMatch(new RegExp(`^${label} has no credential\\. (Run|Set)`))

    if (login === undefined) expect(message).not.toContain("opencode auth login")
    else expect(message).toContain(login)
  })

  it.effect("uses the OpenCode OAuth login for an explicitly selected Zen provider", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "oauth", access: "browser-token" } },
    }), { provider: "zen" }, describeConnection, openCodeClient)

    expect(selected).toMatchObject({ provider: "zen" })
    expect(selected?.redact("browser-token")).toBe("[redacted]")
  }))

  it.effect("uses an OpenCode API-key login when OAuth is absent", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "key", key: "opencode-api-key" } },
    }), { provider: "zen" }, describeConnection, openCodeClient)

    expect(selected).toMatchObject({ provider: "zen" })
  }))

  it.effect("resolves an active OpenCode environment credential", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "env" as const, envName: "OPENCODE_API_KEY" }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      env: { OPENCODE_API_KEY: "environment-key" },
    }), { provider: "zen" }, describeConnection, openCodeClient)

    expect(selected).toMatchObject({ provider: "zen" })
  }))

  it.effect("uses the configured Zen key when OpenCode auth is unavailable", () => Effect.gen(function*() {
    const selected = yield* selectOpenCodeProvider(
      ports(),
      { provider: "zen", apiKey: Redacted.make("zen-key") },
      describeConnection,
      openCodeClient,
    )

    expect(selected).toMatchObject({ provider: "zen" })
  }))

  it.effect("does not inspect OpenCode auth for another selected provider", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "oauth", access: "browser-token" } },
    }), {
      provider: "typesafe",
      apiKey: Redacted.make("typesafe-key"),
    }, describeConnection, openCodeClient)

    expect(selected).toMatchObject({ provider: "typesafe" })
  }))

  it.effect("reports unavailable when the selected provider has no credential", () => Effect.gen(function*() {
    expect(yield* selectOpenCodeProvider(
      ports(),
      { provider: "zen" },
      describeConnection,
      openCodeClient,
    )).toBeUndefined()
  }))
})

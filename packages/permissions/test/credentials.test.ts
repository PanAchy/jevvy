import { Effect, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import {
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
  it.effect("uses the OpenCode OAuth login before runtime configuration", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "oauth", access: "browser-token" } },
    }), "auto", describeConnection, {
      typesafe: Redacted.make("configured-key"),
    }, openCodeClient)

    expect(selected).toMatchObject({ provider: "zen" })
    expect(selected?.redact("browser-token")).toBe("[redacted]")
  }))

  it.effect("uses an OpenCode API-key login when OAuth is absent", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "key", key: "opencode-api-key" } },
    }), "auto", describeConnection, {}, openCodeClient)

    expect(selected).toMatchObject({ provider: "zen" })
  }))

  it.effect("resolves an active OpenCode environment credential", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "env" as const, envName: "OPENCODE_API_KEY" }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      env: { OPENCODE_API_KEY: "environment-key" },
    }), "auto", describeConnection, {}, openCodeClient)

    expect(selected).toMatchObject({ provider: "zen" })
  }))

  it.effect("uses a configured provider when OpenCode auth is unavailable", () => Effect.gen(function*() {
    const selected = yield* selectOpenCodeProvider(
      ports(),
      "auto",
      describeConnection,
      { typesafe: Redacted.make("typesafe-key") },
      openCodeClient,
    )

    expect(selected).toMatchObject({ provider: "typesafe" })
  }))

  it.effect("honors a forced configured provider", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const selected = yield* selectOpenCodeProvider(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "oauth", access: "browser-token" } },
    }), "typesafe", describeConnection, {
      zen: Redacted.make("zen-key"),
      typesafe: Redacted.make("typesafe-key"),
    }, openCodeClient)

    expect(selected).toMatchObject({ provider: "typesafe" })
  }))

  it.effect("reports unavailable when no credential exists", () => Effect.gen(function*() {
    expect(yield* selectOpenCodeProvider(
      ports(),
      "auto",
      describeConnection,
      {},
      openCodeClient,
    )).toBeUndefined()
  }))
})

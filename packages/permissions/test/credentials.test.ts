import { Effect, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import {
  OPENCODE_INTEGRATION,
  resolveCredential,
} from "../src/opencode/credentials.ts"
import type { CredentialPorts, StoredCredential } from "../src/opencode/credentials.ts"

interface Connection {
  readonly id: string
  readonly kind: "credential" | "env"
  readonly envName?: string
}

const describeConnection = (connection: Connection) => connection

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

    const credential = yield* resolveCredential(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "oauth", access: "browser-token" } },
    }), "auto", describeConnection, {
      zen: Redacted.make("configured-key"),
    })

    expect(credential).toMatchObject({
      kind: "zen",
      key: "browser-token",
      origin: "opencode",
    })
  }))

  it.effect("uses an OpenCode API-key login when OAuth is absent", () => Effect.gen(function*() {
    const connection = { id: "opencode", kind: "credential" as const }

    const credential = yield* resolveCredential(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "key", key: "opencode-api-key" } },
    }), "auto", describeConnection)

    expect(credential).toMatchObject({
      kind: "zen",
      key: "opencode-api-key",
      origin: "opencode",
    })
  }))

  it.effect("uses the global or environment Zen key when OpenCode auth is unavailable", () => Effect.gen(function*() {
    const credential = yield* resolveCredential(ports(), "auto", describeConnection, {
      zen: Redacted.make("configured-key"),
    })

    expect(credential).toMatchObject({
      kind: "zen",
      key: "configured-key",
      origin: "config",
    })
  }))

  it.effect("falls back from unavailable Zen to the global or environment TypeSafe key", () => Effect.gen(function*() {
    const credential = yield* resolveCredential(ports(), "auto", describeConnection, {
      typesafe: Redacted.make("typesafe-key"),
    })

    expect(credential).toEqual({
      kind: "typesafe",
      key: "typesafe-key",
      origin: "config",
    })
  }))

  it.effect("honors a forced provider", () => Effect.gen(function*() {
    const credential = yield* resolveCredential(ports(), "typesafe", describeConnection, {
      typesafe: Redacted.make("typesafe-key"),
      zen: Redacted.make("zen-key"),
    })

    expect(credential).toEqual({
      kind: "typesafe",
      key: "typesafe-key",
      origin: "config",
    })
  }))

  it.effect("reports unavailable when no credential exists", () => Effect.gen(function*() {
    expect(yield* resolveCredential(ports(), "auto", describeConnection)).toEqual({ kind: "unavailable" })
  }))
})

import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
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
  activeIntegration: async (id) => options.active?.[id],
  resolveIntegration: async (connection) => options.stored?.[connection.id],
  readEnv: (name) => options.env?.[name],
})

describe("OpenCode credential resolution", () => {
  it("uses the OpenCode OAuth login before runtime configuration", async () => {
    const connection = { id: "opencode", kind: "credential" as const }

    await expect(resolveCredential(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "oauth", access: "browser-token" } },
    }), "auto", describeConnection, {
      zen: Redacted.make("configured-key"),
    })).resolves.toMatchObject({
      kind: "zen",
      key: "browser-token",
      origin: "opencode",
    })
  })

  it("uses an OpenCode API-key login when OAuth is absent", async () => {
    const connection = { id: "opencode", kind: "credential" as const }

    await expect(resolveCredential(ports({
      active: { [OPENCODE_INTEGRATION]: connection },
      stored: { opencode: { type: "key", key: "opencode-api-key" } },
    }), "auto", describeConnection)).resolves.toMatchObject({
      kind: "zen",
      key: "opencode-api-key",
      origin: "opencode",
    })
  })

  it("uses the global or environment Zen key when OpenCode auth is unavailable", async () => {
    await expect(resolveCredential(ports(), "auto", describeConnection, {
      zen: Redacted.make("configured-key"),
    })).resolves.toMatchObject({
      kind: "zen",
      key: "configured-key",
      origin: "config",
    })
  })

  it("falls back from unavailable Zen to the global or environment TypeSafe key", async () => {
    await expect(resolveCredential(ports(), "auto", describeConnection, {
      typesafe: Redacted.make("typesafe-key"),
    })).resolves.toEqual({
      kind: "typesafe",
      key: "typesafe-key",
      origin: "config",
    })
  })

  it("honors a forced provider", async () => {
    await expect(resolveCredential(ports(), "typesafe", describeConnection, {
      typesafe: Redacted.make("typesafe-key"),
      zen: Redacted.make("zen-key"),
    })).resolves.toEqual({
      kind: "typesafe",
      key: "typesafe-key",
      origin: "config",
    })
  })

  it("reports unavailable when no credential exists", async () => {
    await expect(resolveCredential(ports(), "auto", describeConnection)).resolves.toEqual({ kind: "unavailable" })
  })
})

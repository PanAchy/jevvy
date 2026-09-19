// Credential resolution order: zen first (free), TypeSafe second, env
// fallbacks, degraded last. Preference can force one provider.

import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { resolveCredential } from "../../src/plugin/credentials.ts"
import type { ConnectionLike, CredentialPorts, StoredKeyCredential } from "../../src/plugin/credentials.ts"

interface HarnessSetup {
  readonly integrations?: Readonly<Record<string, ConnectionLike>>
  readonly stored?: Readonly<Record<string, StoredKeyCredential>>
  readonly env?: Readonly<Record<string, string>>
}

interface Harness {
  readonly ports: CredentialPorts<ConnectionLike>
}

const makeHarness = (setup: HarnessSetup = {}): Harness => {
  const integrations = new Map(Object.entries(setup.integrations ?? {}))
  const stored = new Map(Object.entries(setup.stored ?? {}))
  const env = new Map(Object.entries(setup.env ?? {}))

  return {
    ports: {
      activeIntegration: (id) => Effect.succeed(integrations.get(id)),
      resolveIntegration: (connection) => Effect.succeed(stored.get(connection.credentialID ?? "")),
      readEnv: (name) => env.get(name),
    },
  }
}

const identity = (connection: ConnectionLike): ConnectionLike => connection

const resolve = async (harness: Harness, preference?: "auto" | "zen" | "typesafe") =>
  Effect.runPromise(resolveCredential(harness.ports, preference, identity))

describe("resolveCredential", () => {
  it("prefers zen when both integrations are connected", async () => {
    const harness = makeHarness({
      integrations: {
        "jevvy-zen": { kind: "credential", credentialID: "zen-conn" },
        "jevvy-typesafe": { kind: "credential", credentialID: "ts-conn" },
      },
      stored: {
        "zen-conn": { type: "key", key: "zen-token" },
        "ts-conn": { type: "key", key: "tsk-key" },
      },
    })

    expect(await resolve(harness)).toMatchObject({ kind: "zen", key: "zen-token", origin: "integration" })
  })

  it("reads the zen model from the stored configuration", async () => {
    const harness = makeHarness({
      integrations: { "jevvy-zen": { kind: "credential", credentialID: "zen-conn" } },
      stored: { "zen-conn": { type: "key", key: "zen-token", configuration: { model: "jev-1.13" } } },
    })

    expect(await resolve(harness)).toMatchObject({ kind: "zen", model: "jev-1.13" })
  })

  it("falls back to the typesafe integration", async () => {
    const harness = makeHarness({
      integrations: { "jevvy-typesafe": { kind: "credential", credentialID: "ts-conn" } },
      stored: { "ts-conn": { type: "key", key: "tsk-key" } },
    })

    expect(await resolve(harness)).toMatchObject({ kind: "typesafe", origin: "integration" })
  })

  it("falls back to env keys per provider", async () => {
    const tsEnv = makeHarness({ env: { TYPESAFE_API_KEY: "tsk-env" } })

    expect(await resolve(tsEnv)).toMatchObject({ kind: "typesafe", key: "tsk-env", origin: "env" })

    const zenEnv = makeHarness({ env: { JEVZY_ZEN_TOKEN: "zen-env" } })

    expect(await resolve(zenEnv)).toMatchObject({ kind: "zen", key: "zen-env", origin: "env" })
  })

  it("zen env wins over typesafe env (free first)", async () => {
    const harness = makeHarness({ env: { TYPESAFE_API_KEY: "tsk-env", OPENCODE_TOKEN: "zen-env" } })

    expect(await resolve(harness)).toMatchObject({ kind: "zen", key: "zen-env" })
  })

  it("preference can force a provider", async () => {
    const harness = makeHarness({
      integrations: { "jevvy-zen": { kind: "credential", credentialID: "zen-conn" } },
      stored: { "zen-conn": { type: "key", key: "zen-token" } },
      env: { TYPESAFE_API_KEY: "tsk-env" },
    })

    expect(await resolve(harness, "typesafe")).toMatchObject({ kind: "typesafe", key: "tsk-env" })
    expect(await resolve(harness, "zen")).toMatchObject({ kind: "zen", key: "zen-token" })
  })

  it("an env-backed connection reads the named variable", async () => {
    const harness = makeHarness({
      integrations: { "jevvy-typesafe": { kind: "env", envName: "TYPESAFE_API_KEY" } },
      env: { TYPESAFE_API_KEY: "tsk-env" },
    })

    expect(await resolve(harness)).toMatchObject({ kind: "typesafe", key: "tsk-env", origin: "integration" })
  })

  it("degrades when nothing is configured", async () => {
    expect(await resolve(makeHarness())).toMatchObject({ kind: "degraded" })
  })

  it("blank keys are ignored", async () => {
    const harness = makeHarness({ env: { TYPESAFE_API_KEY: "   " } })

    expect(await resolve(harness)).toMatchObject({ kind: "degraded" })
  })
})

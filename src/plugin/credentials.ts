// Provider credentials: zen first (free), TypeSafe second, env fallbacks,
// degraded last. Keys live in opencode's integration store (registered by
// the plugin wiring in index.ts) or the environment - never in config
// files. Resolution is pure over injected ports so the order is testable;
// C is the host's connection type, described to resolution via ConnectionLike.

import { Effect } from "effect"

export const TYPESAFE_INTEGRATION = "jevvy-typesafe"

export const ZEN_INTEGRATION = "jevvy-zen"

export const DEFAULT_ZEN_MODEL = "jev-1.13-free"

export type ProviderPreference = "auto" | "zen" | "typesafe"

export type JudgeCredential =
  | { readonly kind: "zen"; readonly key: string; readonly model: string; readonly origin: "integration" | "env" }
  | { readonly kind: "typesafe"; readonly key: string; readonly origin: "integration" | "env" }
  | { readonly kind: "degraded" }

/** The key credential as resolved from the store. */
export interface StoredKeyCredential {
  readonly type: "key"
  readonly key: string
  readonly configuration?: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

/** Everything resolution needs, injectable for tests. */
export interface CredentialPorts<C> {
  readonly activeIntegration: (id: string) => Effect.Effect<C | undefined>
  readonly resolveIntegration: (connection: C) => Effect.Effect<StoredKeyCredential | undefined>
  readonly readEnv: (name: string) => string | undefined
}

/** What resolution needs to know about a connection. */
export interface ConnectionLike {
  readonly kind: "credential" | "env"
  readonly credentialID?: string
  readonly envName?: string
}

const isStoredKey = (credential: StoredKeyCredential | undefined): credential is StoredKeyCredential =>
  credential !== undefined && credential.type === "key" && credential.key.trim().length > 0

const integrationKey = <C>(
  ports: CredentialPorts<C>,
  id: string,
  describe: (connection: C) => ConnectionLike,
): Effect.Effect<StoredKeyCredential | undefined> =>
  Effect.gen(function* () {
    const connection = yield* ports.activeIntegration(id)

    if (connection === undefined) return undefined

    const like = describe(connection)

    if (like.kind === "env" && like.envName !== undefined) {
      const fromEnv = ports.readEnv(like.envName)

      return fromEnv === undefined ? undefined : { type: "key", key: fromEnv }
    }

    const resolved = yield* ports.resolveIntegration(connection)

    return isStoredKey(resolved) ? resolved : undefined
  })

const firstEnv = <C>(ports: CredentialPorts<C>, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = ports.readEnv(name)

    if (value !== undefined && value.trim().length > 0) return value
  }

  return undefined
}

const isModelName = (value: string | number | boolean | readonly string[] | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0

const zenCandidate = <C>(ports: CredentialPorts<C>, describe: (connection: C) => ConnectionLike): Effect.Effect<JudgeCredential> =>
  Effect.gen(function* () {
    const stored = yield* integrationKey(ports, ZEN_INTEGRATION, describe)

    if (stored !== undefined) {
      const model = isModelName(stored.configuration?.model) ? stored.configuration.model : DEFAULT_ZEN_MODEL

      return { kind: "zen", key: stored.key, model, origin: "integration" }
    }

    const fromEnv = firstEnv(ports, ["JEVZY_ZEN_TOKEN", "OPENCODE_TOKEN"])

    return fromEnv === undefined
      ? { kind: "degraded" }
      : { kind: "zen", key: fromEnv, model: DEFAULT_ZEN_MODEL, origin: "env" }
  })

const typesafeCandidate = <C>(
  ports: CredentialPorts<C>,
  describe: (connection: C) => ConnectionLike,
): Effect.Effect<JudgeCredential> =>
  Effect.gen(function* () {
    const stored = yield* integrationKey(ports, TYPESAFE_INTEGRATION, describe)

    if (stored !== undefined) return { kind: "typesafe", key: stored.key, origin: "integration" }

    const fromEnv = firstEnv(ports, ["TYPESAFE_API_KEY"])

    return fromEnv === undefined ? { kind: "degraded" } : { kind: "typesafe", key: fromEnv, origin: "env" }
  })

const degraded: JudgeCredential = { kind: "degraded" }

export const resolveCredential = <C>(
  ports: CredentialPorts<C>,
  preference: ProviderPreference = "auto",
  describe: (connection: C) => ConnectionLike,
): Effect.Effect<JudgeCredential> =>
  Effect.gen(function* () {
    if (preference === "zen") {
      const zen = yield* zenCandidate(ports, describe)

      return zen.kind === "degraded" ? degraded : zen
    }

    if (preference === "typesafe") {
      const typesafe = yield* typesafeCandidate(ports, describe)

      return typesafe.kind === "degraded" ? degraded : typesafe
    }

    const zen = yield* zenCandidate(ports, describe)

    if (zen.kind !== "degraded") return zen

    const typesafe = yield* typesafeCandidate(ports, describe)

    return typesafe.kind === "degraded" ? degraded : typesafe
  })

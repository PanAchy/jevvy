import { DEFAULT_ZEN_MODEL } from "../core.ts"
import { Redacted } from "effect"
import type { ProviderApiKeys, ProviderPreference } from "../config.ts"

export const OPENCODE_INTEGRATION = "opencode"

export type ProviderCredential =
  | { readonly kind: "zen"; readonly key: string; readonly model: string; readonly origin: "opencode" | "config" }
  | { readonly kind: "typesafe"; readonly key: string; readonly origin: "config" }
  | { readonly kind: "unavailable" }

export type StoredCredential =
  | {
      readonly type: "key"
      readonly key: string
      readonly configuration?: Readonly<Record<string, string | number | boolean | readonly string[]>>
    }
  | { readonly type: "oauth"; readonly access: string }

export interface CredentialPorts<C> {
  readonly activeIntegration: (id: string) => Promise<C | undefined>
  readonly resolveIntegration: (connection: C) => Promise<StoredCredential | undefined>
  readonly readEnv: (name: string) => string | undefined
}

export interface ConnectionLike {
  readonly kind: "credential" | "env"
  readonly envName?: string
}

export const credentialToken = (credential: StoredCredential | undefined): string | undefined => {
  const token = credential?.type === "key" ? credential.key : credential?.access

  return token !== undefined && token.trim().length > 0 ? token : undefined
}

const integrationCredential = async <C>(
  ports: CredentialPorts<C>,
  id: string,
  describe: (connection: C) => ConnectionLike,
): Promise<StoredCredential | undefined> => {
  const connection = await ports.activeIntegration(id)

  if (connection === undefined) return undefined

  const like = describe(connection)

  if (like.kind === "env" && like.envName !== undefined) {
    const key = ports.readEnv(like.envName)

    return key === undefined ? undefined : { type: "key", key }
  }

  const resolved = await ports.resolveIntegration(connection)

  return credentialToken(resolved) === undefined ? undefined : resolved
}

const zenCandidate = async <C>(
  ports: CredentialPorts<C>,
  describe: (connection: C) => ConnectionLike,
  configuredKey: ProviderApiKeys["zen"],
): Promise<ProviderCredential> => {
  const opencode = await integrationCredential(ports, OPENCODE_INTEGRATION, describe)
  const opencodeToken = credentialToken(opencode)

  if (opencodeToken !== undefined) {
    return { kind: "zen", key: opencodeToken, model: DEFAULT_ZEN_MODEL, origin: "opencode" }
  }

  if (configuredKey !== undefined) {
    return { kind: "zen", key: Redacted.value(configuredKey), model: DEFAULT_ZEN_MODEL, origin: "config" }
  }

  return { kind: "unavailable" }
}

const typeSafeCandidate = (
  configuredKey: ProviderApiKeys["typesafe"],
): ProviderCredential => {
  if (configuredKey !== undefined) {
    return { kind: "typesafe", key: Redacted.value(configuredKey), origin: "config" }
  }

  return { kind: "unavailable" }
}

export const resolveCredential = async <C>(
  ports: CredentialPorts<C>,
  preference: ProviderPreference,
  describe: (connection: C) => ConnectionLike,
  apiKeys: ProviderApiKeys = {},
): Promise<ProviderCredential> => {
  if (preference === "zen") return zenCandidate(ports, describe, apiKeys.zen)

  if (preference === "typesafe") return typeSafeCandidate(apiKeys.typesafe)

  const zen = await zenCandidate(ports, describe, apiKeys.zen)

  return zen.kind === "unavailable" ? typeSafeCandidate(apiKeys.typesafe) : zen
}

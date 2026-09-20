import { Effect } from "effect"
import type { JevClient } from "../core.ts"
import { createProvider, selectConfiguredProvider } from "../providers.ts"
import type { ProviderApiKeys, ProviderPreference, SelectedProvider } from "../providers.ts"

export const OPENCODE_INTEGRATION = "opencode"

export type StoredCredential =
  | {
      readonly type: "key"
      readonly key: string
      readonly configuration?: Readonly<Record<string, string | number | boolean | readonly string[]>>
    }
  | { readonly type: "oauth"; readonly access: string }

export interface CredentialPorts<C> {
  readonly activeIntegration: (id: string) => Effect.Effect<C | undefined>
  readonly resolveIntegration: (connection: C) => Effect.Effect<StoredCredential | undefined>
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

const resolveOpenCodeCredential = Effect.fn("Credentials.resolveOpenCodeCredential")(function*<C>(
  ports: CredentialPorts<C>,
  describe: (connection: C) => ConnectionLike,
): Effect.fn.Return<StoredCredential | undefined> {
  const connection = yield* ports.activeIntegration(OPENCODE_INTEGRATION)

  if (connection === undefined) return undefined

  const like = describe(connection)

  if (like.kind === "env" && like.envName !== undefined) {
    const key = ports.readEnv(like.envName)

    return key === undefined ? undefined : { type: "key", key }
  }

  const resolved = yield* ports.resolveIntegration(connection)

  return credentialToken(resolved) === undefined ? undefined : resolved
})

export const selectOpenCodeProvider = Effect.fn("Credentials.selectOpenCodeProvider")(function*<C>(
  ports: CredentialPorts<C>,
  preference: ProviderPreference,
  describe: (connection: C) => ConnectionLike,
  apiKeys: ProviderApiKeys,
  createOpenCodeClient: (apiKey: string) => JevClient,
): Effect.fn.Return<SelectedProvider | undefined> {
  const configured = selectConfiguredProvider(preference, apiKeys)

  if (preference !== "auto" && preference !== "zen") return configured

  const credential = yield* resolveOpenCodeCredential(ports, describe)
  const apiKey = credentialToken(credential)

  return apiKey === undefined
    ? configured
    : createProvider("zen", apiKey, createOpenCodeClient(apiKey))
})

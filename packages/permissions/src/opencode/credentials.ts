import { Effect } from "effect"
import type { JevClient } from "../core.ts"
import {
  createBuiltInProvider,
  createConfiguredProvider,
  providerApiKeyEnvironment,
  providerDisplayName,
} from "../providers.ts"
import type { BuiltInProvider, ProviderSelection, SelectedProvider } from "../providers.ts"

export const OPENCODE_INTEGRATION = "opencode"

export const missingConfigurationMessage = (configPath: string): string =>
  `Jevvy cannot start because no provider is configured. Run "npx @jevvy/permissions init", or create ${configPath} manually. OpenCode's remaining permission flow remains unchanged.`

export const missingCredentialMessage = (provider: BuiltInProvider, configPath: string): string => {
  const credentialSources = provider === "zen"
    ? `Run "opencode auth login opencode", set ${providerApiKeyEnvironment(provider)}`
    : `Set ${providerApiKeyEnvironment(provider)}`

  return `${providerDisplayName(provider)} has no credential. ${credentialSources}, add providers.${provider}.apiKey to ${configPath}, or run "npx @jevvy/permissions init". OpenCode's remaining permission flow remains unchanged.`
}

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
  selection: ProviderSelection,
  describe: (connection: C) => ConnectionLike,
  createOpenCodeClient: (apiKey: string) => JevClient,
): Effect.fn.Return<SelectedProvider | undefined> {
  const configured = createConfiguredProvider(selection)

  if (selection.provider !== "zen") return configured

  const credential = yield* resolveOpenCodeCredential(ports, describe)
  const apiKey = credentialToken(credential)

  return apiKey === undefined
    ? configured
    : createBuiltInProvider("zen", apiKey, createOpenCodeClient(apiKey))
})

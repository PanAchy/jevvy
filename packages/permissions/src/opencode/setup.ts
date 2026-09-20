import {
  providerApiKeyEnvironment,
  providerDisplayName,
} from "../providers.ts"
import type { BuiltInProvider } from "../providers.ts"

export const missingConfigurationMessage = (configPath: string): string =>
  `Jevvy cannot start because no provider is configured. Run "npx @jevvy/permissions init", or create ${configPath} manually. OpenCode's remaining permission flow remains unchanged.`

export const missingCredentialMessage = (provider: BuiltInProvider, configPath: string): string =>
  `${providerDisplayName(provider)} has no credential. Set ${providerApiKeyEnvironment(provider)}, add providers.${provider}.apiKey to ${configPath}, or run "npx @jevvy/permissions init". OpenCode's remaining permission flow remains unchanged.`

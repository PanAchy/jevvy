import { chmod, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from "effect"
import { parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { JevProvider } from "./core.ts"
import { ApprovalQuestions } from "./questions.ts"
import { providerApiKeyEnvironment } from "./providers.ts"
import type { BuiltInProvider, ProviderSelection } from "./providers.ts"

const ProviderCredentialSchema = Schema.Struct({
  apiKey: Schema.NonEmptyString,
})

const CustomProviderSchema = Schema.Struct({
  endpoint: Schema.URLFromString,
  model: Schema.NonEmptyString,
  apiKey: Schema.optionalKey(Schema.NonEmptyString),
})

const JevvyConfigSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  provider: JevProvider,
  providers: Schema.optionalKey(Schema.Struct({
    zen: Schema.optionalKey(ProviderCredentialSchema),
    typesafe: Schema.optionalKey(ProviderCredentialSchema),
    openrouter: Schema.optionalKey(ProviderCredentialSchema),
    vercel: Schema.optionalKey(ProviderCredentialSchema),
    custom: Schema.optionalKey(CustomProviderSchema),
  })),
  permissions: Schema.optionalKey(Schema.Struct({
    questions: Schema.optionalKey(ApprovalQuestions),
  })),
})

interface ConfigDocument extends Schema.Schema.Type<typeof JevvyConfigSchema> {}

export type JevvyConfig =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "shipped-policy"; readonly selection: ProviderSelection }
  | {
      readonly kind: "custom-policy"
      readonly selection: ProviderSelection
      readonly questions: ApprovalQuestions
    }
  | { readonly kind: "invalid"; readonly message: string }

class ConfigMissing extends Schema.TaggedError<ConfigMissing>()("ConfigMissing", {}) {}

class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  reason: Schema.Literals(["read", "schema", "permissions"]),
}) {}

const EnvironmentApiKeys = Config.all({
  zen: Config.option(Config.redacted(providerApiKeyEnvironment("zen"))),
  typesafe: Config.option(Config.redacted(providerApiKeyEnvironment("typesafe"))),
  openrouter: Config.option(Config.redacted(providerApiKeyEnvironment("openrouter"))),
  vercel: Config.option(Config.redacted(providerApiKeyEnvironment("vercel"))),
})

type EnvironmentApiKeys = Config.Success<typeof EnvironmentApiKeys>

const hasCredentials = (document: ConfigDocument): boolean =>
  document.providers?.zen !== undefined ||
  document.providers?.typesafe !== undefined ||
  document.providers?.openrouter !== undefined ||
  document.providers?.vercel !== undefined ||
  document.providers?.custom?.apiKey !== undefined

const readDocument = Effect.fn("JevvyConfig.readDocument")(function*(path: string) {
  const raw = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return new ConfigMissing()

      return new ConfigFileError({ reason: "read" })
    },
  })

  const parseErrors: ParseError[] = []
  const decoded: unknown = parse(raw, parseErrors, { allowTrailingComma: true, disallowComments: false })

  if (parseErrors.length > 0) return yield* new ConfigFileError({ reason: "schema" })

  const document = yield* Schema.decodeUnknownEffect(JevvyConfigSchema, {
    onExcessProperty: "error",
  })(decoded).pipe(
    Effect.mapError(() => new ConfigFileError({ reason: "schema" })),
  )

  if (process.platform !== "win32" && hasCredentials(document)) {
    const info = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: () => new ConfigFileError({ reason: "read" }),
    })

    if ((info.mode & 0o777) !== 0o600) {
      yield* Effect.tryPromise({
        try: () => chmod(path, 0o600),
        catch: () => new ConfigFileError({ reason: "permissions" }),
      })
    }
  }

  return document
})

const invalidMessage = (reason: ConfigFileError["reason"]): string => {
  if (reason === "permissions") return "credential-bearing jevvy.jsonc could not be secured"

  if (reason === "read") return "jevvy.jsonc could not be read"

  return "jevvy.jsonc does not match the configuration schema"
}

export const globalJevvyConfigPath = (): string => {
  const override = process.env.JEVVY_CONFIG?.trim()

  if (override !== undefined && override.length > 0) return override

  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const root = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config")

  return join(root, "jevvy", "jevvy.jsonc")
}

const environmentApiKey = (
  provider: BuiltInProvider,
  keys: EnvironmentApiKeys,
): Redacted.Redacted<string> | undefined => Option.getOrUndefined(keys[provider])

const providerSelection = (
  document: ConfigDocument,
  environment: EnvironmentApiKeys,
): Effect.Effect<ProviderSelection, ConfigFileError> => {
  if (document.provider === "custom") {
    const custom = document.providers?.custom

    if (custom === undefined || (custom.endpoint.protocol !== "http:" && custom.endpoint.protocol !== "https:")) {
      return new ConfigFileError({ reason: "schema" })
    }

    const apiKey = custom.apiKey === undefined ? undefined : Redacted.make(custom.apiKey)

    return Effect.succeed({
      provider: "custom",
      endpoint: custom.endpoint.href,
      model: custom.model,
      apiKey,
    })
  }

  const fileApiKey = document.providers?.[document.provider]?.apiKey

  const apiKey = fileApiKey === undefined
    ? environmentApiKey(document.provider, environment)
    : Redacted.make(fileApiKey)

  return Effect.succeed({ provider: document.provider, apiKey })
}

const load = Effect.fn("JevvyConfig.load")(function*(path: string, environment: ConfigProvider.ConfigProvider) {
  const document = yield* readDocument(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ConfigMissing", () => Effect.succeed(Option.none<ConfigDocument>())),
  )

  if (Option.isNone(document)) return { kind: "unconfigured" as const }

  const environmentKeys = yield* EnvironmentApiKeys.parse(environment).pipe(
    Effect.mapError(() => new ConfigFileError({ reason: "schema" })),
  )

  const selection = yield* providerSelection(document.value, environmentKeys)
  const questions = document.value.permissions?.questions

  if (questions === undefined) return { kind: "shipped-policy" as const, selection }

  return { kind: "custom-policy" as const, selection, questions }
}, Effect.catchTag("ConfigFileError", (error) =>
  Effect.succeed({ kind: "invalid" as const, message: invalidMessage(error.reason) })))

export const loadJevvyConfig = (
  path = globalJevvyConfigPath(),
  environment = ConfigProvider.fromEnv(),
) => load(path, environment)

import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { DEFAULT_LAYA_MODEL, JevProvider } from "./core.ts"
import { ApprovalQuestions } from "./questions.ts"
import { HarnessReviewConfig } from "./review-control.ts"
import { providerApiKeyEnvironment } from "./providers.ts"
import type { BuiltInProvider, ProviderSelection } from "./providers.ts"
import { globalJevvyConfigPath } from "./config-path.ts"

export { globalJevvyConfigPath } from "./config-path.ts"

const ProviderCredentialSchema = Schema.Struct({
  apiKey: Schema.NonEmptyString,
})

const SystemOnePresetSettings = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  opencodeCredential: Schema.optionalKey(Schema.NonEmptyString),
})

const EndpointProviderSchema = Schema.Struct({
  endpoint: Schema.URLFromString,
  model: Schema.NonEmptyString,
  apiKey: Schema.optionalKey(Schema.NonEmptyString),
})

export const LayaPolicy = Schema.Struct({
  checkpoint: Schema.Literals(["english", "multilingual", "typed-decisions"]),
  questions: ApprovalQuestions,
})

export interface LayaPolicy extends Schema.Schema.Type<typeof LayaPolicy> {}

const LayaProviderSchema = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.URLFromString),
  model: Schema.optionalKey(Schema.Literals(["english", "multilingual", "typed-decisions"])),
  apiKey: Schema.optionalKey(Schema.NonEmptyString),
  policy: Schema.optionalKey(LayaPolicy),
})

const ReviewAskPatternSettings = Schema.Struct({
  opencode: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  claude: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
})

interface ReviewAskPatterns extends Schema.Schema.Type<typeof ReviewAskPatternSettings> {}

const JevvyConfigSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  provider: JevProvider,
  providers: Schema.optionalKey(Schema.Struct({
    zen: Schema.optionalKey(SystemOnePresetSettings),
    typesafe: Schema.optionalKey(SystemOnePresetSettings),
    openrouter: Schema.optionalKey(SystemOnePresetSettings),
    vercel: Schema.optionalKey(SystemOnePresetSettings),
    openai: Schema.optionalKey(ProviderCredentialSchema),
    microsoft: Schema.optionalKey(EndpointProviderSchema),
    laya: Schema.optionalKey(LayaProviderSchema),
    custom: Schema.optionalKey(EndpointProviderSchema),
  })),
  permissions: Schema.Struct({
    timeoutMs: Schema.optionalKey(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
    reviewAskPatterns: ReviewAskPatternSettings.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
    questions: Schema.optionalKey(ApprovalQuestions),
    opencode: Schema.optionalKey(HarnessReviewConfig),
    claude: Schema.optionalKey(HarnessReviewConfig),
  }).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
})

interface ConfigDocument extends Schema.Schema.Type<typeof JevvyConfigSchema> {}

export type JevvyConfig =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "shipped-policy"; readonly selection: ProviderSelection; readonly timeoutMs: number; readonly reviewAskPatterns: ReviewAskPatterns }
  | {
      readonly kind: "custom-policy"
      readonly selection: ProviderSelection
      readonly questions: ApprovalQuestions
      readonly timeoutMs: number
      readonly reviewAskPatterns: ReviewAskPatterns
    }
  | { readonly kind: "invalid"; readonly message: string }

class ConfigMissing extends Schema.TaggedError<ConfigMissing>()("ConfigMissing", {}) {}

class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  reason: Schema.Literals(["read", "schema", "permissions", "policy"]),
}) {}

const EnvironmentApiKeys = Config.all({
  zen: Config.option(Config.Redacted(providerApiKeyEnvironment("zen"))),
  typesafe: Config.option(Config.Redacted(providerApiKeyEnvironment("typesafe"))),
  openrouter: Config.option(Config.Redacted(providerApiKeyEnvironment("openrouter"))),
  vercel: Config.option(Config.Redacted(providerApiKeyEnvironment("vercel"))),
  openai: Config.option(Config.Redacted(providerApiKeyEnvironment("openai"))),
  microsoft: Config.option(Config.Redacted(providerApiKeyEnvironment("microsoft"))),
  laya: Config.option(Config.Redacted(providerApiKeyEnvironment("laya"))),
})

type EnvironmentApiKeys = Config.Success<typeof EnvironmentApiKeys>

const hasCredentials = (document: ConfigDocument): boolean =>
  document.providers?.zen?.apiKey !== undefined ||
  document.providers?.typesafe?.apiKey !== undefined ||
  document.providers?.openrouter?.apiKey !== undefined ||
  document.providers?.vercel?.apiKey !== undefined ||
  document.providers?.openai?.apiKey !== undefined ||
  document.providers?.microsoft?.apiKey !== undefined ||
  document.providers?.laya?.apiKey !== undefined ||
  document.providers?.custom?.apiKey !== undefined

const readDocument = Effect.fn("JevvyConfig.readDocument")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem

  const raw = yield* fs.readFileString(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => new ConfigMissing()),
    Effect.mapError((error) => error instanceof ConfigMissing ? error : new ConfigFileError({ reason: "read" })),
  )

  const parseErrors: ParseError[] = []
  const decoded: unknown = parse(raw, parseErrors, { allowTrailingComma: true, disallowComments: false })

  if (parseErrors.length > 0) return yield* new ConfigFileError({ reason: "schema" })

  const document = yield* Schema.decodeUnknownEffect(JevvyConfigSchema, {
    onExcessProperty: "error",
  })(decoded).pipe(
    Effect.mapError(() => new ConfigFileError({ reason: "schema" })),
  )

  if (process.platform !== "win32" && hasCredentials(document)) {
    const info = yield* fs.stat(path).pipe(Effect.mapError(() => new ConfigFileError({ reason: "read" })))

    if ((info.mode & 0o777) !== 0o600) {
      yield* fs.chmod(path, 0o600).pipe(Effect.mapError(() => new ConfigFileError({ reason: "permissions" })))
    }
  }

  return document
})

const invalidMessage = (reason: ConfigFileError["reason"]): string => {
  if (reason === "policy") {
    return "Laya requires providers.laya.policy with matching checkpoint and questions; calibrate it before enabling auto-approval (top-level permissions.questions cannot configure Laya)"
  }

  if (reason === "permissions") return "credential-bearing jevvy.jsonc could not be secured"

  if (reason === "read") return "jevvy.jsonc could not be read"

  return "jevvy.jsonc does not match the configuration schema"
}

const environmentApiKey = (
  provider: BuiltInProvider,
  keys: EnvironmentApiKeys,
): Redacted.Redacted<string> | undefined => Option.getOrUndefined(keys[provider])

const providerSelection = (
  document: ConfigDocument,
  environment: EnvironmentApiKeys,
): Effect.Effect<ProviderSelection, ConfigFileError> => {
  if (document.provider === "custom" || document.provider === "microsoft") {
    const custom = document.providers?.[document.provider]

    if (custom === undefined || (custom.endpoint.protocol !== "http:" && custom.endpoint.protocol !== "https:")) {
      return new ConfigFileError({ reason: "schema" })
    }

    if (document.provider === "microsoft" && (custom.endpoint.protocol !== "https:" ||
      custom.endpoint.username !== "" || custom.endpoint.password !== "")) {
      return new ConfigFileError({ reason: "schema" })
    }

    const apiKey = custom.apiKey === undefined
      ? document.provider === "microsoft" ? environmentApiKey("microsoft", environment) : undefined
      : Redacted.make(custom.apiKey)

    return Effect.succeed({
      provider: document.provider,
      endpoint: custom.endpoint.href,
      model: custom.model,
      apiKey,
    })
  }

  if (document.provider === "laya") {
    const laya = document.providers?.laya

    if (laya?.endpoint !== undefined && laya.endpoint.protocol !== "http:" && laya.endpoint.protocol !== "https:") {
      return new ConfigFileError({ reason: "schema" })
    }

    const fileApiKey = laya?.apiKey
    const apiKey = fileApiKey === undefined ? environmentApiKey("laya", environment) : Redacted.make(fileApiKey)

    return Effect.succeed({
      provider: "laya",
      endpoint: laya?.endpoint?.href,
      model: laya?.model,
      apiKey,
    })
  }

  const fileApiKey = document.providers?.[document.provider]?.apiKey

  const apiKey = fileApiKey === undefined
    ? environmentApiKey(document.provider, environment)
    : Redacted.make(fileApiKey)

  if (document.provider === "openai") return Effect.succeed({ provider: "openai", apiKey })

  return Effect.succeed({
    provider: document.provider,
    apiKey,
    model: document.providers?.[document.provider]?.model,
    opencodeCredential: document.providers?.[document.provider]?.opencodeCredential,
  })
}

const load = Effect.fn("JevvyConfig.load")(function*(path: string, environment: ConfigProvider.ConfigProvider) {
  const document = yield* readDocument(path).pipe(
    Effect.asSome,
    Effect.catchTag("ConfigMissing", () => Effect.succeed(Option.none<ConfigDocument>())),
  )

  if (Option.isNone(document)) return { kind: "unconfigured" as const }

  const environmentKeys = yield* EnvironmentApiKeys.parse(environment).pipe(
    Effect.mapError(() => new ConfigFileError({ reason: "schema" })),
  )

  const selection = yield* providerSelection(document.value, environmentKeys)
  const timeoutMs = document.value.permissions?.timeoutMs ?? 5_000

  const reviewAskPatterns = document.value.permissions.reviewAskPatterns

  if (selection.provider === "laya") {
    const policy = document.value.providers?.laya?.policy

    if (document.value.permissions?.questions !== undefined || policy === undefined ||
      policy.checkpoint !== (selection.model ?? DEFAULT_LAYA_MODEL)) {
      return yield* new ConfigFileError({ reason: "policy" })
    }

    return { kind: "custom-policy" as const, selection, questions: policy.questions, timeoutMs, reviewAskPatterns }
  }

  const questions = document.value.permissions?.questions

  if (questions === undefined) return { kind: "shipped-policy" as const, selection, timeoutMs, reviewAskPatterns }

  return { kind: "custom-policy" as const, selection, questions, timeoutMs, reviewAskPatterns }
}, Effect.catchTag("ConfigFileError", (error) =>
  Effect.succeed({ kind: "invalid" as const, message: invalidMessage(error.reason) })))

export const loadJevvyConfig = (
  path = globalJevvyConfigPath(),
  environment = ConfigProvider.fromEnv(),
) => load(path, environment)

import { chmod, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Config, ConfigProvider, Effect, Option, Schema } from "effect"
import type { Redacted } from "effect"
import { parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import type { ApprovalQuestions } from "./questions.ts"

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const CriteriaSchema = Schema.Struct({
  false: Schema.NonEmptyString,
  true: Schema.NonEmptyString,
})

const ApprovalQuestionSchema = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Schema.NonEmptyString,
  criteria: Schema.optional(CriteriaSchema),
  threshold: Schema.Struct({
    direction: Schema.Literals(["atLeast", "atMost"]),
    value: Probability,
  }),
})

const ApprovalQuestionsSchema = Schema.Record(Schema.NonEmptyString, ApprovalQuestionSchema)

const ProviderPreferenceSchema = Schema.Literals(["auto", "zen", "typesafe"])

const ProviderCredentialSchema = Schema.Struct({
  apiKey: Schema.NonEmptyString,
})

const JevvyConfigSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderPreferenceSchema),
  providers: Schema.optional(Schema.Struct({
    zen: Schema.optional(ProviderCredentialSchema),
    typesafe: Schema.optional(ProviderCredentialSchema),
  })),
  permissions: Schema.optional(Schema.Struct({
    questions: Schema.optional(ApprovalQuestionsSchema),
  })),
})

interface ConfigDocument extends Schema.Schema.Type<typeof JevvyConfigSchema> {}

export interface ProviderApiKeys {
  readonly zen?: Redacted.Redacted<string>
  readonly typesafe?: Redacted.Redacted<string>
}

export type ProviderPreference = Schema.Schema.Type<typeof ProviderPreferenceSchema>

export type JevvyConfig =
  | { readonly kind: "default"; readonly provider: ProviderPreference; readonly apiKeys: ProviderApiKeys }
  | {
      readonly kind: "custom"
      readonly provider: ProviderPreference
      readonly apiKeys: ProviderApiKeys
      readonly questions: ApprovalQuestions
    }
  | { readonly kind: "invalid"; readonly message: string }

class ConfigMissing extends Schema.TaggedError<ConfigMissing>()("ConfigMissing", {}) {}

class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  reason: Schema.Literals(["read", "schema", "permissions"]),
}) {}

const fileApiKey = (provider: "zen" | "typesafe") =>
  Config.redacted("apiKey").pipe(
    Config.nested(provider),
    Config.nested("providers"),
  )

const RuntimeConfig = Config.all({
  provider: Config.schema(ProviderPreferenceSchema, "provider"),
  zen: Config.option(fileApiKey("zen").pipe(
    Config.orElse(() => Config.redacted("OPENCODE_API_KEY")),
  )),
  typesafe: Config.option(fileApiKey("typesafe").pipe(
    Config.orElse(() => Config.redacted("TYPESAFE_API_KEY")),
  )),
  questions: Config.option(Config.schema(ApprovalQuestionsSchema, ["permissions", "questions"])),
})

const hasCredentials = (document: ConfigDocument): boolean =>
  document.providers?.zen !== undefined || document.providers?.typesafe !== undefined

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

const load = Effect.fn("JevvyConfig.load")(function*(path: string, environment: ConfigProvider.ConfigProvider) {
  const document = yield* readDocument(path).pipe(
    Effect.catchTag("ConfigMissing", () => Effect.succeed({} satisfies ConfigDocument)),
  )

  const provider = ConfigProvider.fromUnknown({ provider: "auto", ...document }).pipe(
    ConfigProvider.orElse(environment),
  )

  const config = yield* RuntimeConfig.parse(provider).pipe(
    Effect.mapError(() => new ConfigFileError({ reason: "schema" })),
  )

  let apiKeys: ProviderApiKeys = {}

  if (Option.isSome(config.zen)) apiKeys = { zen: config.zen.value }

  if (Option.isSome(config.typesafe)) apiKeys = { ...apiKeys, typesafe: config.typesafe.value }

  if (Option.isNone(config.questions)) return { kind: "default" as const, provider: config.provider, apiKeys }

  if (Object.keys(config.questions.value).length === 0) {
    return { kind: "invalid" as const, message: "permissions.questions must contain at least one question" }
  }

  return { kind: "custom" as const, provider: config.provider, apiKeys, questions: config.questions.value }
}, Effect.catchTag("ConfigFileError", (error) =>
  Effect.succeed({ kind: "invalid" as const, message: invalidMessage(error.reason) })))

export const loadJevvyConfig = (
  path = globalJevvyConfigPath(),
  environment = ConfigProvider.fromEnv(),
) => load(path, environment)

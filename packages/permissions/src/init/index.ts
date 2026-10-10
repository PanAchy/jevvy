import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { DEFAULT_LAYA_ENDPOINT, DEFAULT_LAYA_MODEL } from "../core.ts"
import { LayaPolicy } from "../config.ts"
import { createConfigFile } from "../config-file.ts"

const CONFIG_SCHEMA = "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json"

const OPENCODE_PLUGIN = "@jevvy/permissions"

const CLAUDE_MARKETPLACE = "PanAchy/jevvy"

const CLAUDE_PLUGIN = "jevvy-permissions@jevvy"

type InstallOperation =
  | "install-opencode"
  | "install-claude-marketplace"
  | "install-claude-plugin"

export const InitHarness = Schema.Literals(["opencode", "claude"])

export type InitHarness = typeof InitHarness.Type

export type InitProvider =
  | {
      readonly provider: "zen" | "typesafe" | "openrouter" | "vercel"
      readonly apiKey: Redacted.Redacted<string>
    }
  | {
      readonly provider: "laya"
      readonly endpoint?: string
      readonly model?: string
      readonly apiKey?: Redacted.Redacted<string>
    }
  | {
      readonly provider: "custom"
      readonly endpoint: string
      readonly model: string
      readonly apiKey?: Redacted.Redacted<string>
    }

export interface InitPlan {
  readonly harnesses: readonly InitHarness[]
  readonly provider: InitProvider
}

export interface InitResult {
  readonly configPath: string
  readonly harnesses: readonly InitHarness[]
  readonly provider: InitProvider["provider"]
}

export class InitError extends Schema.TaggedError<InitError>()("InitError", {
  operation: Schema.Literals([
    "read-config",
    "parse-config",
    "write-config",
    "install-opencode",
    "install-claude-marketplace",
    "install-claude-plugin",
    "validate-plan",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InitPlatform extends Context.Service<InitPlatform, {
  readonly readConfig: (path: string) => Effect.Effect<string | undefined, InitError>
  readonly updateConfig: (path: string, edit: (raw: string | undefined) => Effect.Effect<string, InitError>) => Effect.Effect<void, InitError>
  readonly installHarness: (harness: InitHarness) => Effect.Effect<void, InitError>
}>()("@jevvy/permissions/InitPlatform") {
  static readonly layer = Layer.effect(
    InitPlatform,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const readConfig = Effect.fn("InitPlatform.readConfig")(function*(path: string) {
        const exists = yield* fs.exists(path)

        if (!exists) return undefined

        return yield* fs.readFileString(path)
      }, Effect.mapError((cause) => new InitError({
        operation: "read-config",
        message: "Jevvy configuration could not be read",
        cause,
      })))

      const updateConfig = Effect.fn("InitPlatform.updateConfig")(function*(
        path: string,
        edit: (raw: string | undefined) => Effect.Effect<string, InitError>,
      ) {
        const file = yield* createConfigFile(path).pipe(Effect.provide(Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths))))

        return yield* file.update((raw) => edit(raw).pipe(
          Effect.map((content) => ({ content, value: undefined })),
        )).pipe(Effect.catchTag("ConfigFileError", (cause) => new InitError({
          operation: cause.operation === "read" ? "read-config" : "write-config",
          message: "Jevvy configuration could not be updated",
          cause,
        })))
      })

      const runInstaller = Effect.fn("InitPlatform.runInstaller")(function*(
        operation: InstallOperation,
        failureMessage: string,
        command: ChildProcess.Command,
      ) {
        const code = yield* spawner.exitCode(command).pipe(
          Effect.mapError((cause) => new InitError({ operation, message: failureMessage, cause })),
        )

        if (code !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new InitError({
            operation,
            message: `${failureMessage} because the command exited with code ${code}`,
          })
        }
      })

      const installHarness = Effect.fn("InitPlatform.installHarness")(function*(harness: InitHarness) {
        if (harness === "opencode") {
          return yield* runInstaller(
            "install-opencode",
            "OpenCode could not install the Jevvy plugin",
            ChildProcess.make(
              "opencode",
              ["plugin", "add", OPENCODE_PLUGIN],
              { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
            ),
          )
        }

        yield* runInstaller(
          "install-claude-marketplace",
          "Claude Code could not add the Jevvy marketplace",
          ChildProcess.make(
            "claude",
            ["plugin", "marketplace", "add", "--scope", "user", CLAUDE_MARKETPLACE],
            { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
          ),
        )

        yield* runInstaller(
          "install-claude-plugin",
          "Claude Code could not install the Jevvy plugin",
          ChildProcess.make(
            "claude",
            ["plugin", "install", "--scope", "user", CLAUDE_PLUGIN],
            { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
          ),
        )
      })

      return InitPlatform.of({ readConfig, updateConfig, installHarness })
    }),
  )
}

const providerSettings = (provider: InitProvider): Readonly<Record<string, string>> | undefined => {
  const apiKey = provider.apiKey === undefined ? undefined : Redacted.value(provider.apiKey)

  if (provider.provider === "custom") {
    return apiKey === undefined
      ? { endpoint: provider.endpoint, model: provider.model }
      : { endpoint: provider.endpoint, model: provider.model, apiKey }
  }

  if (provider.provider === "laya") {
    const settings: Record<string, string> = {}

    if (provider.endpoint !== undefined) settings.endpoint = provider.endpoint

    if (provider.model !== undefined) settings.model = provider.model

    if (apiKey !== undefined) settings.apiKey = apiKey

    return Object.keys(settings).length === 0 ? undefined : settings
  }

  return { apiKey: Redacted.value(provider.apiKey) }
}

const formattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const

const ConfigRoot = Schema.Record(Schema.String, Schema.Unknown)

type ConfigEditValue = string | Readonly<Record<string, string>> | undefined

const updateJsonc = (raw: string, path: readonly string[], value: ConfigEditValue): string =>
  applyEdits(raw, modify(raw, [...path], value, { formattingOptions }))

export const renderJevvyConfig = Effect.fn("Init.renderJevvyConfig")(function*(
  existing: string | undefined,
  provider: InitProvider,
): Effect.fn.Return<string, InitError> {
  const settings = providerSettings(provider)

  if (existing === undefined) {
    const document = settings === undefined
      ? { $schema: CONFIG_SCHEMA, provider: provider.provider }
      : {
          $schema: CONFIG_SCHEMA,
          provider: provider.provider,
          providers: { [provider.provider]: settings },
        }

    return `${JSON.stringify(document, null, 2)}\n`
  }

  const errors: ParseError[] = []
  const decoded: unknown = parse(existing, errors, { allowTrailingComma: true, disallowComments: false })

  if (errors.length > 0) {
    return yield* new InitError({
      operation: "parse-config",
      message: "Existing jevvy.jsonc is not valid JSONC",
    })
  }

  const document = yield* Schema.decodeUnknownEffect(ConfigRoot)(decoded).pipe(
    Effect.mapError((cause) => new InitError({
      operation: "parse-config",
      message: "Existing jevvy.jsonc must contain an object",
      cause,
    })),
  )

  const hasQuestions = Schema.is(ConfigRoot)(document.permissions) && "questions" in document.permissions

  if (hasQuestions && (provider.provider === "laya" || document.provider === "laya")) {
    const message = document.provider === "laya" && provider.provider !== "laya"
      ? "Move the old top-level Laya questions to providers.laya.policy before switching providers; your config was not changed"
      : "Move or remove top-level permission questions before selecting Laya; its policy belongs under providers.laya.policy. Your config was not changed"

    return yield* new InitError({
      operation: "validate-plan",
      message,
    })
  }

  let preserveLayaPolicy = false

  if (provider.provider === "laya") {
    const providers = Schema.is(ConfigRoot)(document.providers) ? document.providers : undefined
    const previous = Schema.is(ConfigRoot)(providers?.laya) ? providers.laya : undefined

    if (previous !== undefined && "policy" in previous) {
      if (!Schema.is(LayaPolicy)(previous.policy)) {
        return yield* new InitError({
          operation: "validate-plan",
          message: "Existing Laya policy is malformed; fix it before running init. Your config was not changed",
        })
      }

      const priorEndpoint = previous.endpoint ?? DEFAULT_LAYA_ENDPOINT
      const nextEndpoint = provider.endpoint ?? DEFAULT_LAYA_ENDPOINT
      const priorModel = previous.model ?? DEFAULT_LAYA_MODEL
      const nextModel = provider.model ?? DEFAULT_LAYA_MODEL

      if (priorEndpoint !== nextEndpoint || priorModel !== nextModel) {
        return yield* new InitError({
          operation: "validate-plan",
          message: "Laya server or checkpoint changed. Move the existing policy aside and recalibrate before running init; your config was not changed",
        })
      }

      preserveLayaPolicy = true
    }
  }

  let updated = updateJsonc(existing, ["$schema"], CONFIG_SCHEMA)
  updated = updateJsonc(updated, ["provider"], provider.provider)

  if (provider.provider === "laya" && preserveLayaPolicy) {
    for (const field of ["endpoint", "model", "apiKey"] as const) {
      updated = updateJsonc(updated, ["providers", "laya", field], settings?.[field])
    }
  } else {
    updated = updateJsonc(updated, ["providers", provider.provider], provider.provider === "laya" ? settings ?? {} : settings)
  }

  return updated.endsWith("\n") ? updated : `${updated}\n`
})

export const initializeJevvy = Effect.fn("Init.initializeJevvy")(function*(
  plan: InitPlan,
  configPath: string,
): Effect.fn.Return<InitResult, InitError, InitPlatform> {
  if (plan.harnesses.length === 0) {
    return yield* new InitError({
      operation: "validate-plan",
      message: "Select at least one harness",
    })
  }

  const platform = yield* InitPlatform
  yield* platform.updateConfig(configPath, (existing) => renderJevvyConfig(existing, plan.provider))
  yield* Effect.forEach(plan.harnesses, platform.installHarness, { discard: true })

  return {
    configPath,
    harnesses: plan.harnesses,
    provider: plan.provider.provider,
  }
})

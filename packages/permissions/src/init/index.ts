import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"

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
  readonly writeConfig: (path: string, content: string) => Effect.Effect<void, InitError>
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

      const writeConfig = Effect.fn("InitPlatform.writeConfig")(function*(path: string, content: string) {
        const directory = paths.dirname(path)

        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })

        const temporary = yield* fs.makeTempFile({ directory, prefix: ".jevvy-", suffix: ".tmp" })

        yield* Effect.gen(function*() {
          yield* fs.writeFileString(temporary, content, { mode: 0o600 })
          yield* fs.chmod(temporary, 0o600)
          yield* fs.rename(temporary, path)
          yield* fs.chmod(path, 0o600)
        }).pipe(
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        )
      }, Effect.mapError((cause) => new InitError({
        operation: "write-config",
        message: "Jevvy configuration could not be written",
        cause,
      })))

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

      return InitPlatform.of({ readConfig, writeConfig, installHarness })
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

  yield* Schema.decodeUnknownEffect(ConfigRoot)(decoded).pipe(
    Effect.mapError((cause) => new InitError({
      operation: "parse-config",
      message: "Existing jevvy.jsonc must contain an object",
      cause,
    })),
  )

  let updated = updateJsonc(existing, ["$schema"], CONFIG_SCHEMA)
  updated = updateJsonc(updated, ["provider"], provider.provider)
  updated = updateJsonc(updated, ["providers", provider.provider], settings)

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
  const existing = yield* platform.readConfig(configPath)
  const content = yield* renderJevvyConfig(existing, plan.provider)

  yield* platform.writeConfig(configPath, content)
  yield* Effect.forEach(plan.harnesses, platform.installHarness, { discard: true })

  return {
    configPath,
    harnesses: plan.harnesses,
    provider: plan.provider.provider,
  }
})

import { Effect, FileSystem, Path, Schema } from "effect"
import { acquireConfigLease } from "./config-lease.ts"

export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  operation: Schema.Literals(["read", "busy", "write"]),
}) {}

type Prepare = (temporary: string, content: string) => Effect.Effect<void, ConfigFileError>

export const createConfigFile = Effect.fn("ConfigFile.create")(function*(path: string, prepare?: Prepare) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const directory = paths.dirname(path)

  const read = Effect.fn("ConfigFile.read")(function*() {
    return yield* fs.readFileString(path).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      Effect.mapError(() => new ConfigFileError({ operation: "read" })),
    )
  })

  const update = Effect.fn("ConfigFile.update")(function*<A, E, R>(
    edit: (raw: string | undefined) => Effect.Effect<{ readonly content: string; readonly value: A }, E, R>,
  ) {
    return yield* Effect.scoped(Effect.gen(function*() {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
        Effect.mapError(() => new ConfigFileError({ operation: "write" })),
      )

      const lease = yield* acquireConfigLease(path).pipe(
        Effect.mapError((error) => new ConfigFileError({ operation: error.operation })),
      )

      const edited = yield* edit(yield* read())

      const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".jevvy-write-" }).pipe(
        Effect.mapError(() => new ConfigFileError({ operation: "write" })),
      )

      yield* fs.chmod(temporary, 0o600).pipe(Effect.mapError(() => new ConfigFileError({ operation: "write" })))
      yield* prepare === undefined
        ? fs.writeFileString(temporary, edited.content).pipe(Effect.mapError(() => new ConfigFileError({ operation: "write" })))
        : prepare(temporary, edited.content)
      yield* lease.replace(temporary).pipe(
        Effect.mapError((error) => new ConfigFileError({ operation: error.operation })),
      )

      return edited.value
    }))
  }, Effect.uninterruptible)

  return { read, update }
})

export type ConfigFile = Effect.Success<ReturnType<typeof createConfigFile>>

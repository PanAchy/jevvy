import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, opendir } from "node:fs/promises"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class HistoryNativeError extends Schema.TaggedError<HistoryNativeError>()("HistoryNativeError", {
  kind: Schema.Literals(["missing", "exists", "storage"]),
}) {}

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))

const exists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))

const native = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: async () => operation(),
  catch: (error) => new HistoryNativeError({ kind: missing(error) ? "missing" : exists(error) ? "exists" : "storage" }),
})

export interface HistoryFile {
  readonly stat: Effect.Effect<Stats, HistoryNativeError>
  readonly read: (length: number) => Effect.Effect<{ buffer: Buffer; bytesRead: number }, HistoryNativeError>
  readonly readText: Effect.Effect<string, HistoryNativeError>
  readonly writeText: (content: string) => Effect.Effect<void, HistoryNativeError>
  readonly close: Effect.Effect<void, HistoryNativeError>
}

export interface HistoryDirectory {
  readonly read: Effect.Effect<{ name: string } | null, HistoryNativeError>
  readonly close: Effect.Effect<void, HistoryNativeError>
}

export interface HistoryNative {
  readonly lstat: (path: string) => Effect.Effect<Stats, HistoryNativeError>
  readonly mkdir: (path: string) => Effect.Effect<void, HistoryNativeError>
  readonly open: (path: string, create: boolean) => Effect.Effect<HistoryFile, HistoryNativeError>
  readonly opendir: (path: string) => Effect.Effect<HistoryDirectory, HistoryNativeError>
}

export const historyNative: HistoryNative = {
  lstat: (path) => native(() => lstat(path)),
  mkdir: (path) => native(() => mkdir(path, { mode: 0o700 })),
  open: (path, create) => native(() => open(path, create
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600)).pipe(Effect.map((file): HistoryFile => ({
      stat: native(() => file.stat()),
      read: (length) => native(() => file.read({ buffer: Buffer.alloc(length), length, position: 0 })),
      readText: native(() => file.readFile("utf8")),
      writeText: (content) => native(() => file.writeFile(content)),
      close: native(() => file.close()),
    }))),
  opendir: (path) => native(() => opendir(path)).pipe(Effect.map((directory) => ({
    read: native(() => directory.read()),
    close: native(() => directory.close()),
  }))),
}

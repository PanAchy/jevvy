import type { Stats } from "node:fs"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { HISTORY_DATABASE_BYTES, HistoryStorageError } from "../history.ts"
import { historyMetadata } from "./metadata-values.ts"
import { historyNative } from "./history-native.ts"
import type { HistoryNative, HistoryNativeError } from "./history-native.ts"

const privateFileMetadata = (info: Stats, maximum: number): boolean =>
  info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600 && info.size <= maximum

const privateFile = (info: Stats, maximum: number): boolean =>
  privateFileMetadata(info, maximum) && info.nlink === 1

const privateDirectory = (info: Stats): boolean =>
  info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700

const historyFileLimits = {
  "history.sqlite": HISTORY_DATABASE_BYTES,
  "history.sqlite-journal": 40 * 1024 * 1024,
  "AGENTS.md": 65_536,
  "schema.sql": 65_536,
  "event.schema.json": 65_536,
}

const privateJournalSnapshot = (info: Stats): boolean =>
  privateFileMetadata(info, historyFileLimits["history.sqlite-journal"]) && (info.nlink === 0 || info.nlink === 1)

export const createHistoryFiles = (files: HistoryNative, platform = process.platform) => {
  const inspect = Effect.fn("ReviewHistory.inspectFile")(function*(path: string, maximum: number) {
    const info = yield* files.lstat(path).pipe(Effect.catchIf((error) => error.kind === "missing", () => Effect.succeed(undefined)))

    if (info !== undefined && !privateFile(info, maximum)) return yield* new HistoryStorageError({ kind: "unsafe-path" })

    return info
  })

  const inspectJournalSnapshot = Effect.fn("ReviewHistory.inspectJournalSnapshot")(function*(path: string) {
    const info = yield* files.lstat(path).pipe(Effect.catchIf((error) => error.kind === "missing", () => Effect.succeed(undefined)))

    if (info !== undefined && !privateJournalSnapshot(info)) return yield* new HistoryStorageError({ kind: "unsafe-path" })

    return info
  })

  const revalidateJournal = Effect.fn("ReviewHistory.revalidateJournal")(function*(path: string) {
    const paths = yield* Path.Path
    const parent = yield* files.lstat(paths.dirname(path))

    if (!privateDirectory(parent)) return yield* new HistoryStorageError({ kind: "unsafe-path" })
    yield* inspectJournalSnapshot(path)

    return yield* new HistoryStorageError({ kind: "busy" })
  })

  const inspectJournalFile = Effect.fn("ReviewHistory.inspectJournalFile")(function*(path: string) {
    const info = yield* inspectJournalSnapshot(path)

    if (info?.nlink === 0) return yield* revalidateJournal(path)

    return info
  })

  const inspectJournal = Effect.fn("ReviewHistory.inspectJournal")(function*(filename: string) {
    const path = `${filename}-journal`
    const info = yield* inspectJournalFile(path)

    if (info === undefined) return

    const acquire = files.open(path, false).pipe(Effect.catchIf((error) => error.kind === "missing", () => Effect.succeed(undefined)))
    yield* Effect.acquireUseRelease(acquire, (file) => Effect.gen(function*() {
      if (file === undefined) return
      const opened = yield* file.stat

      if (!privateJournalSnapshot(opened)) return yield* new HistoryStorageError({ kind: "unsafe-path" })

      if (opened.nlink === 0 || opened.dev !== info.dev || opened.ino !== info.ino) return yield* revalidateJournal(path)

      const { buffer, bytesRead } = yield* file.read(28)

      if (bytesRead < 28) return yield* new HistoryStorageError({ kind: "busy" })

      const magic = buffer.subarray(0, 8).toString("hex")
      const pages = buffer.readUInt32BE(8)
      const initialPages = buffer.readUInt32BE(16)
      const sector = buffer.readUInt32BE(20)
      const pageSize = buffer.readUInt32BE(24)

      if ((magic !== "d9d505f920a163d7" && magic !== "0000000000000000") ||
        (pages > 8192 && pages !== 0xffffffff) || initialPages > 8192 || pageSize !== 4096 ||
        sector < 512 || sector > 65_536 || (sector & (sector - 1)) !== 0) return yield* new HistoryStorageError({ kind: "unsupported-schema" })

      if (opened.size < sector) return yield* new HistoryStorageError({ kind: "busy" })
    }), (file) => file === undefined ? Effect.void : file.close)
  })

  const inspectDatabase = Effect.fn("ReviewHistory.inspectDatabase")(function*(filename: string) {
    yield* Effect.acquireUseRelease(files.open(filename, false), (file) => Effect.gen(function*() {
      const info = yield* file.stat

      if (!privateFile(info, HISTORY_DATABASE_BYTES)) return yield* new HistoryStorageError({ kind: "unsafe-path" })

      if (info.size === 0) return

      const { buffer, bytesRead } = yield* file.read(100)

      if (bytesRead < 100 || info.size % 4096 !== 0 || buffer.subarray(0, 16).toString("hex") !== "53514c69746520666f726d6174203300" ||
        buffer.readUInt16BE(16) !== 4096 || buffer[18] !== 1 || buffer[19] !== 1) return yield* new HistoryStorageError({ kind: "unsupported-schema" })
    }), (file) => file.close)
  })

  const storageError = Effect.mapError((error: HistoryStorageError | HistoryNativeError) => error instanceof HistoryStorageError ? error : new HistoryStorageError({ kind: "storage" }))

  const verifyHistoryPath = Effect.fn("ReviewHistory.verifyPath")(function*(path: VerifiedHistoryPath) {
    const info = yield* inspect(path.filename, HISTORY_DATABASE_BYTES)

    if (info === undefined || info.dev !== path.dev || info.ino !== path.ino) return yield* new HistoryStorageError({ kind: "unsafe-path" })

    for (const suffix of ["-wal", "-shm"]) {
      if ((yield* inspect(`${path.filename}${suffix}`, HISTORY_DATABASE_BYTES)) !== undefined) return yield* new HistoryStorageError({ kind: "unsupported-schema" })
    }

    yield* inspectJournal(path.filename)
  }, storageError, Effect.provide(Path.layer))

  const resolveHistoryRoot = Effect.fn("ReviewHistory.resolveRoot")(function*(configPath: string) {
    if (platform === "win32") return yield* new HistoryStorageError({ kind: "unsupported-platform" })
    const { dirname, join, resolve } = yield* Path.Path

    const parent = resolve(dirname(configPath))
    let ancestor = parent

    for (;;) {
      const info = yield* files.lstat(ancestor)

      if (!info.isDirectory() || (info.uid !== 0 && info.uid !== process.getuid?.()) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) return yield* new HistoryStorageError({ kind: "unsafe-path" })
      const next = dirname(ancestor)

      if (next === ancestor) break
      ancestor = next
    }

    const parentInfo = yield* files.lstat(parent)

    if (!privateDirectory(parentInfo)) return yield* new HistoryStorageError({ kind: "unsafe-path" })

    return join(parent, "metrics")
  })

  const inspectEntries = Effect.fn("ReviewHistory.inspectEntries")(function*(root: string) {
    const { join } = yield* Path.Path
    const allowed = new Set(Object.keys(historyFileLimits))

    const entries = yield* Effect.acquireUseRelease(files.opendir(root), (directory) => Effect.gen(function*() {
      const entries: string[] = []

      for (let index = 0; index <= allowed.size; index++) {
        const entry = yield* directory.read

        if (entry === null) break

        entries.push(entry.name)
      }

      return entries
    }), (directory) => directory.close)

    if (entries.length > allowed.size || entries.some((name) => !allowed.has(name))) return yield* new HistoryStorageError({ kind: "unsupported-schema" })
    let total = 0

    for (const [name, maximum] of Object.entries(historyFileLimits)) {
      if (!entries.includes(name)) continue
      const info = yield* name === "history.sqlite-journal" ? inspectJournalFile(join(root, name)) : inspect(join(root, name), maximum)
      total += info?.size ?? 0
    }

    if (total > 80 * 1024 * 1024) return yield* new HistoryStorageError({ kind: "storage" })

    return entries
  })

  const preflightHistoryStore = Effect.fn("ReviewHistory.preflightPath")(function*(configPath: string) {
    const root = yield* resolveHistoryRoot(configPath)
    const info = yield* files.lstat(root).pipe(Effect.catchIf((error) => error.kind === "missing", () => Effect.succeed(undefined)))

    if (info === undefined) return

    if (!privateDirectory(info)) return yield* new HistoryStorageError({ kind: "unsafe-path" })
    yield* inspectEntries(root)
  }, storageError, Effect.provide(Path.layer))

  const prepareHistoryStore = Effect.fn("ReviewHistory.preparePath")(function*(configPath: string) {
    const { join } = yield* Path.Path
    const root = yield* resolveHistoryRoot(configPath)

    yield* files.mkdir(root).pipe(Effect.catchIf((error) => error.kind === "exists", () => Effect.void))

    const rootInfo = yield* files.lstat(root)

    if (!privateDirectory(rootInfo)) return yield* new HistoryStorageError({ kind: "unsafe-path" })

    if (Object.values(historyMetadata).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 65_536) return yield* new HistoryStorageError({ kind: "storage" })
    const entries = yield* inspectEntries(root)

    if (entries.includes("history.sqlite-journal") && !entries.includes("history.sqlite")) return yield* new HistoryStorageError({ kind: "unsupported-schema" })
    const filename = join(root, "history.sqlite")

    const create = files.open(filename, true).pipe(Effect.catchIf((error) => error.kind === "exists", () => Effect.succeed(undefined)))
    yield* Effect.acquireUseRelease(create, () => Effect.void, (file) => file === undefined ? Effect.void : file.close)

    const info = yield* inspect(filename, HISTORY_DATABASE_BYTES)

    if (info === undefined) return yield* new HistoryStorageError({ kind: "unsafe-path" })

    yield* inspectDatabase(filename)
    yield* inspectJournal(filename)

    for (const [name, content] of Object.entries(historyMetadata)) {
      const target = join(root, name)

      const file = files.open(target, true).pipe(Effect.map((handle) => ({ handle, created: true })), Effect.catchIf((error) => error.kind === "exists", () => Effect.gen(function*() {
        yield* inspect(target, 65_536)

        return { handle: yield* files.open(target, false), created: false }
      })))

      yield* Effect.acquireUseRelease(file, ({ handle, created }) => Effect.gen(function*() {
        if (created) return yield* handle.writeText(content)
        const actual = yield* handle.readText

        if (actual !== content) return yield* new HistoryStorageError({ kind: content.startsWith(actual) ? "busy" : "unsupported-schema" })
      }), ({ handle }) => handle.close)
    }

    return { filename, dev: info.dev, ino: info.ino }
  }, storageError, Effect.provide(Path.layer))

  return { prepareHistoryStore, verifyHistoryPath, preflightHistoryStore }
}

export interface VerifiedHistoryPath {
  readonly filename: string
  readonly dev: number
  readonly ino: number
}

export const { prepareHistoryStore, verifyHistoryPath, preflightHistoryStore } = createHistoryFiles(historyNative)

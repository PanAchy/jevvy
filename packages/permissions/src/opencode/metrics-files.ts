import { randomUUID } from "node:crypto"
import { constants, renameSync, unlinkSync } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, opendir } from "node:fs/promises"
import * as Clock from "effect/Clock"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { acquireConfigLease } from "../config-lease.ts"
import type { PermissionReviewer } from "../engine.ts"
import { createReviewMetrics, decodeMetricsSnapshot, MetricsDocument, MetricsWriter, METRICS_WRITER_LIMIT } from "../metrics.ts"

export const METRICS_DOCUMENT_BYTES = 65_536

export const METRICS_STALE_MS = 120_000

export const metricsAgentInstructions = `# Jevvy Permissions aggregate API v1

## Analysis

- Before reporting, validate snapshot.json with schema.json, including the field descriptions and counter/time consistency checks.
- Use valid, unexpired writer entries. Report missing or unreadable data as unavailable, not zero.
- Flag incomplete or saturated entries and describe retained totals as partial, not a complete history.

## Files

- Jevvy maintains these generated files. Write reports elsewhere.
- Keep analysis within this metrics directory. Adjacent provider configuration may contain credentials and is not needed.
`

export const metricsWindowsProblem = "Jevvy Permissions metrics are unavailable on Windows because this integration cannot verify user-only directory ACLs. Set metrics.enabled to false to dismiss this diagnostic. Permission reviews are unchanged."

const storageProblem = "Jevvy Permissions metrics could not update the global metrics directory. Check its ownership, permissions, free space and schema version. Jevvy will retry automatically; permission reviews are unchanged."

const busyProblem = "Jevvy Permissions metrics are temporarily unavailable because the metrics lease is busy or 16 active writers fill the bounded store. Jevvy will retry automatically; permission reviews are unchanged."

class MetricsFilesError extends Schema.TaggedError<MetricsFilesError>()("MetricsFilesError", {
  reason: Schema.Literals(["storage", "busy"]),
}) {}

const exists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))

const PendingName = Schema.String.check(Schema.isPattern(/^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))

const pendingName = Schema.is(PendingName)

const Envelope = Schema.Struct({ schemaVersion: Schema.Literal(1), writers: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(METRICS_WRITER_LIMIT)) })

export const createNativeOperations = () => {
  let pending: Promise<void> | undefined

  const run = <A>(operation: () => Promise<A>) => Effect.tryPromise({
    try: () => {
      if (pending) return Promise.reject(new MetricsFilesError({ reason: "busy" }))

      const result = Promise.resolve().then(operation)
      const completion = result.then(() => undefined, () => undefined).finally(() => { pending = undefined })

      pending = completion

      return completion.then(() => result)
    },
    catch: (error) => error instanceof MetricsFilesError ? error : new MetricsFilesError({ reason: "storage" }),
  })

  return { run, idle: Effect.promise(() => pending ?? Promise.resolve()) }
}

const secureDirectory = async (path: string, privateMode = false): Promise<void> => {
  const info = await lstat(path)

  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 ||
    (privateMode && (info.mode & 0o777) !== 0o700)) throw new Error("unsafe metrics directory")
}

const privateFile = (info: Stats, maximum: number): boolean =>
  info.isFile() && info.uid === process.getuid?.() && info.nlink === 1 && (info.mode & 0o777) === 0o600 && info.size <= maximum

const readPrivate = async (path: string, maximum: number): Promise<string | undefined> => {
  try {
    const info = await lstat(path)

    if (!privateFile(info, maximum)) throw new Error("unsafe metrics file")

    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)

    try {
      if (!privateFile(await file.stat(), maximum)) throw new Error("unsafe opened metrics file")

      const data = await file.read({ buffer: Buffer.alloc(maximum + 1), length: maximum + 1, position: 0 })

      if (data.bytesRead > maximum) throw new Error("oversized metrics file")

      return data.buffer.subarray(0, data.bytesRead).toString("utf8")
    } finally {
      await file.close()
    }
  } catch (error) {
    if (missing(error)) return undefined

    throw error
  }
}

const prepareRoot = async (configPath: string, paths: Path.Path): Promise<string> => {
  const parent = paths.resolve(paths.dirname(configPath))
  let ancestor = parent

  for (;;) {
    const info = await lstat(ancestor)

    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) throw new Error("unsafe metrics ancestor")

    const next = paths.dirname(ancestor)

    if (next === ancestor) break

    ancestor = next
  }

  await secureDirectory(parent)
  const root = paths.join(parent, "metrics")

  try {
    await mkdir(root, { mode: 0o700 })
  } catch (error) {
    if (!exists(error)) throw error
  }

  await secureDirectory(root, true)

  return root
}

const readWriters = Effect.fn("MetricsFiles.read")(function*(raw: string | undefined) {
  if (raw === undefined) return []

  const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(Envelope), { onExcessProperty: "error" })(raw).pipe(
    Effect.mapError(() => new MetricsFilesError({ reason: "storage" })),
  )

  const writers: MetricsWriter[] = []

  for (const input of envelope.writers) {
    const writer = yield* Schema.decodeUnknownEffect(MetricsWriter, { onExcessProperty: "error" })(input).pipe(Effect.option)

    if (Option.isNone(writer) || writers.some((entry) => entry.token === writer.value.token)) continue

    const snapshot = yield* decodeMetricsSnapshot(JSON.stringify(writer.value.snapshot))

    if (Option.isSome(snapshot)) writers.push(writer.value)
  }

  return writers
})

export const persistReviewMetrics = Effect.fn("MetricsFiles.persist")(function*(
  reviewer: PermissionReviewer,
  enabled: boolean,
  configPath: string,
  shippedQuestions: boolean,
  report: (problem: string | undefined) => void = () => undefined,
) {
  if (!enabled) return reviewer

  if (process.platform === "win32") {
    yield* Effect.try({ try: () => report(metricsWindowsProblem), catch: () => undefined }).pipe(Effect.ignore)

    return reviewer
  }

  const token = yield* Effect.try({ try: randomUUID, catch: () => new MetricsFilesError({ reason: "storage" }) }).pipe(Effect.option)

  if (Option.isNone(token)) {
    yield* Effect.try({ try: () => report(storageProblem), catch: () => undefined }).pipe(Effect.ignore)

    return reviewer
  }

  const metrics = yield* createReviewMetrics(reviewer, shippedQuestions)
  const paths = yield* Path.Path
  const operations = createNativeOperations()
  const native = operations.run

  const flush = Effect.fn("MetricsFiles.flush")(function*(closed: boolean) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const root = yield* native(() => prepareRoot(configPath, paths))
      const path = paths.join(root, "snapshot.json")

      yield* native(async () => {
        try {
          await secureDirectory(`${path}.review-lock`)
        } catch (error) {
          if (!missing(error)) throw error
        }
      })

      const lease = yield* acquireConfigLease(path, 3).pipe(Effect.mapError(() => new MetricsFilesError({ reason: "busy" })))

      const names = yield* native(async () => {
        const directory = await opendir(root)
        const entries: string[] = []

        try {
          for (let count = 0; count < 65; count++) {
            const entry = await directory.read()

            if (entry === null) return entries

            entries.push(entry.name)
          }

          throw new Error("metrics directory has too many entries")
        } finally {
          await directory.close()
        }
      })

      for (const name of names) {
        if (!pendingName(name)) continue

        const pending = paths.join(root, name)

        yield* native(() => readPrivate(pending, METRICS_DOCUMENT_BYTES))
        yield* lease.withOwnership(() => unlinkSync(pending))
      }

      const replace = Effect.fn("MetricsFiles.replace")(function*(name: string, content: string, maximum: number) {
        if (Buffer.byteLength(content) > maximum) return yield* new MetricsFilesError({ reason: "storage" })

        const target = paths.join(root, name)
        const previous = yield* native(() => readPrivate(target, maximum))

        if (previous === content) return

        const temporary = paths.join(root, `.pending-${randomUUID()}`)

        yield* native(async () => {
          const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)

          try {
            await file.writeFile(content)
          } finally {
            await file.close()
          }
        })
        yield* lease.withOwnership(() => renameSync(temporary, target))
      })

      const raw = yield* native(() => readPrivate(path, METRICS_DOCUMENT_BYTES))
      const writers = (yield* readWriters(raw)).filter((writer) => writer.token !== token.value)
      const now = yield* Clock.currentTimeMillis

      if (writers.length >= METRICS_WRITER_LIMIT) {
        const reclaimable = writers.filter((writer) => writer.closed || writer.snapshot.updatedAtMs <= now - METRICS_STALE_MS)
          .sort((left, right) => left.snapshot.updatedAtMs - right.snapshot.updatedAtMs)[0]

        if (reclaimable === undefined) return yield* new MetricsFilesError({ reason: "busy" })

        writers.splice(writers.indexOf(reclaimable), 1)
      }

      writers.push({ token: token.value, closed, snapshot: yield* metrics.snapshot })
      const document: MetricsDocument = { schemaVersion: 1, writers }
      const data = yield* Schema.encodeEffect(Schema.fromJsonString(MetricsDocument))(document)
      const schema = Schema.toJsonSchemaDocument(MetricsDocument, { onExcessProperty: "error" })

      yield* replace("schema.json", JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema.schema, $defs: schema.definitions }, null, 2), 16_384)
      yield* replace("AGENTS.md", metricsAgentInstructions, 16_384)
      yield* replace("snapshot.json", data, METRICS_DOCUMENT_BYTES)
    }))
  })

  const attempt = Effect.fn("MetricsFiles.attempt")(function*(closed: boolean) {
    const problem = yield* flush(closed).pipe(
      Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause) && Cause.hasDies(cause), () => Effect.fail(new MetricsFilesError({ reason: "storage" }))),
      Effect.timeout("3 seconds"),
      Effect.match({ onFailure: (error) => error instanceof MetricsFilesError && error.reason === "busy" ? busyProblem : storageProblem, onSuccess: () => undefined }),
    )

    yield* Effect.try({ try: () => report(problem), catch: () => undefined }).pipe(Effect.ignore)
  })

  yield* attempt(false)
  yield* Effect.addFinalizer(() => operations.idle.pipe(Effect.timeout("500 millis"), Effect.ignore, Effect.andThen(attempt(true))))
  yield* attempt(false).pipe(Effect.schedule(Schedule.spaced("30 seconds")), Effect.forkScoped)

  return metrics.reviewer
})

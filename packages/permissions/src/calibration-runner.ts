import { createHash } from "node:crypto"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { buildCalibrationPlan, calibrationMetaRecord, numericAnswers, parseCalibrationCorpus, summarizeCalibration } from "./calibration.ts"
import type { CalibrationMeta, CalibrationPlanEntry, CalibrationRecord, CalibrationSummary } from "./calibration.ts"
import { JevResult } from "./core.ts"
import { permissionEffectOf } from "./engine.ts"
import type { SelectedProvider } from "./providers.ts"
import { toNoulQuestions } from "./questions.ts"

export class CalibrationError extends Schema.TaggedError<CalibrationError>()("CalibrationError", {
  operation: Schema.Literals(["read", "parse", "write", "evaluate", "setup"]),
  message: Schema.String,
}) {}

export const calibrationHash = (text: string): string => createHash("sha256").update(text).digest("hex")

export const loadCalibrationCorpus = Effect.fn("Calibration.loadCorpus")(function*(path: string, name = path) {
  const fs = yield* FileSystem.FileSystem

  const raw = yield* fs.readFileString(path).pipe(Effect.mapError(() => new CalibrationError({
    operation: "read", message: `Could not read calibration corpus ${name}`,
  })))

  const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(raw).pipe(Effect.mapError(
    () => new CalibrationError({ operation: "parse", message: `${name} does not match the calibration corpus schema` }),
  ))

  const corpus = yield* Effect.try({
    try: () => parseCalibrationCorpus(value, name),
    catch: (cause) => new CalibrationError({ operation: "parse", message: cause instanceof Error ? cause.message : String(cause) }),
  })

  return { name, corpus, hash: calibrationHash(raw) }
})

export const loadCalibrationPlan = Effect.fn("Calibration.loadPlan")(function*(paths: readonly { readonly path: string; readonly name: string }[]) {
  const corpora = yield* Effect.forEach(paths, ({ path, name }) => loadCalibrationCorpus(path, name))

  const plan = yield* Effect.try({
    try: () => buildCalibrationPlan(corpora),
    catch: (cause) => new CalibrationError({ operation: "parse", message: String(cause) }),
  })

  return { corpora, plan }
})

export interface CalibrationRun {
  readonly plan: readonly CalibrationPlanEntry[]
  readonly meta: CalibrationMeta
  readonly provider: Pick<SelectedProvider, "client" | "redact">
  readonly output: string
  readonly spacing: number
  readonly progress: (completed: number, record: CalibrationRecord) => void
}

type CalibrationOutputRecord = ReturnType<typeof calibrationMetaRecord> | CalibrationRecord | CalibrationSummary

export const runCalibrationPlan = Effect.fn("Calibration.runPlan")(function*(run: CalibrationRun) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const output = paths.resolve(run.output)
  const questions = toNoulQuestions(run.meta.questions)
  const writeError = () => new CalibrationError({ operation: "write", message: `Could not write calibration output ${output}` })

  yield* fs.makeDirectory(paths.dirname(output), { recursive: true }).pipe(Effect.mapError(writeError))
  const file = yield* fs.open(output, { mode: 0o600, flag: "wx" }).pipe(Effect.mapError(writeError))
  const encoder = new TextEncoder()
  const write = (record: CalibrationOutputRecord) => file.writeAll(encoder.encode(`${JSON.stringify(record)}\n`)).pipe(Effect.mapError(writeError))
  yield* write(calibrationMetaRecord(run.meta))

  const records: CalibrationRecord[] = []

  for (const entry of run.plan) {
    const started = yield* Clock.currentTimeMillis

    const outcome = yield* run.provider.client.evaluate({
      state: { action: "shell", resource: entry.command }, questions,
    }).pipe(
      Effect.timeout(30_000),
      Effect.flatMap((judged) => JevResult.makeEffect(judged).pipe(Effect.mapError(
        () => new CalibrationError({ operation: "evaluate", message: "invalid calibration judgment" }),
      ))),
      Effect.flatMap((judged) => Effect.gen(function*() {
        if (judged.model.trim().length === 0) return yield* new CalibrationError({ operation: "evaluate", message: "missing model identifier" })

        const effect = yield* Effect.try({
          try: () => permissionEffectOf(judged.answers, run.meta.questions),
          catch: (cause) => new CalibrationError({ operation: "evaluate", message: cause instanceof Error ? cause.message : String(cause) }),
        })

        return { judged, effect }
      })),
      Effect.match({ onSuccess: (result) => ({ kind: "result" as const, ...result }), onFailure: (error) => ({ kind: "error" as const, error }) }),
    )

    const finished = yield* Clock.currentTimeMillis
    const timing = { ms: finished - started, timestamp: new Date(finished).toISOString() }

    const record: CalibrationRecord = outcome.kind === "result"
      ? { ...entry, status: "result", effect: outcome.effect, answers: numericAnswers(outcome.judged.answers),
        model: outcome.judged.model, reportedModel: outcome.judged.reportedModel, ...timing }
      : { ...entry, status: "error", error: run.provider.redact(String(outcome.error)).slice(0, 500), ...timing }

    yield* write(record)
    records.push(record)
    yield* Effect.sync(() => run.progress(records.length, record))

    if (records.length < run.plan.length && run.spacing > 0) yield* Effect.sleep(run.spacing)
  }

  const completedAt = yield* Clock.currentTimeMillis
  const summary = summarizeCalibration(run.meta, records, new Date(completedAt).toISOString())
  yield* write(summary)

  return { output, summary }
}, Effect.scoped)

import type { JevProvider, Json, NoulAnswer } from "./core.ts"
import type { ApprovalQuestions } from "./questions.ts"
import { Schema } from "effect"

export type CalibrationWant = "allow" | "ask" | "must-ask"

export interface CalibrationCommand {
  readonly command: string
  readonly want: CalibrationWant
}

export interface CalibrationCorpus {
  readonly meta?: {
    readonly note?: string
    readonly repeatCount?: number
  }
  readonly commands: readonly CalibrationCommand[]
  readonly repeats?: readonly string[]
}

export interface NamedCalibrationCorpus {
  readonly name: string
  readonly corpus: CalibrationCorpus
  readonly hash: string
}

export interface CalibrationPlanEntry extends CalibrationCommand {
  readonly corpus: string
  readonly kind: "base" | "repeat"
  readonly probe?: number
}

export interface CalibrationMeta {
  readonly provider: JevProvider
  readonly requestedModel: string
  readonly questions: ApprovalQuestions
  readonly questionHash: string
  readonly createdAt: string
  readonly calls: number
  readonly corpora: readonly {
    readonly name: string
    readonly hash: string
  }[]
  readonly commit?: string
}

interface CalibrationRecordBase extends CalibrationPlanEntry {
  readonly ms: number
  readonly timestamp: string
}

export interface CalibrationResultRecord extends CalibrationRecordBase {
  readonly status: "result"
  readonly effect: "allow" | "ask"
  readonly answers: Readonly<Record<string, number>>
  readonly model: string
}

export interface CalibrationErrorRecord extends CalibrationRecordBase {
  readonly status: "error"
  readonly error: string
}

export type CalibrationRecord = CalibrationResultRecord | CalibrationErrorRecord

export interface CalibrationSummary {
  readonly summary: true
  readonly completedAt: string
  readonly result: "passed" | "failed"
  readonly failed: boolean
  readonly counts: {
    readonly planned: number
    readonly completed: number
    readonly errors: number
    readonly mustAskLeaks: number
    readonly modelMismatches: number
    readonly labelMismatches: number
  }
  readonly matrix: Readonly<Record<CalibrationWant, Readonly<Record<"allow" | "ask", number>>>>
  readonly repeated: readonly {
    readonly corpus: string
    readonly command: string
    readonly question: string
    readonly mean: number
    readonly minimum: number
    readonly maximum: number
    readonly standardDeviation: number
    readonly verdicts: Readonly<Record<"allow" | "ask", number>>
  }[]
  readonly latency?: {
    readonly p50: number
    readonly p90: number
    readonly mean: number
    readonly maximum: number
  }
  readonly mustAskLeaks: readonly { readonly corpus: string; readonly command: string }[]
  readonly labelMismatches: readonly {
    readonly corpus: string
    readonly command: string
    readonly want: CalibrationWant
    readonly effect: "allow" | "ask"
  }[]
  readonly modelMismatches: readonly {
    readonly corpus: string
    readonly command: string
    readonly requested: string
    readonly served: string
  }[]
  readonly errors: readonly { readonly corpus: string; readonly command: string; readonly error: string }[]
}

const CalibrationCorpusSchema = Schema.Struct({
  meta: Schema.optional(Schema.Struct({
    note: Schema.optional(Schema.String),
    repeatCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  })),
  commands: Schema.Array(Schema.Struct({
    command: Schema.NonEmptyString,
    want: Schema.Literals(["allow", "ask", "must-ask"]),
  })).check(Schema.isMinLength(1)),
  repeats: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export const parseCalibrationCorpus = (value: Json, name: string): CalibrationCorpus => {
  let decoded: CalibrationCorpus

  try {
    decoded = Schema.decodeUnknownSync(CalibrationCorpusSchema, { onExcessProperty: "error" })(value)
  } catch {
    throw new Error(`${name} does not match the calibration corpus schema`)
  }

  if ((decoded.repeats?.length ?? 0) > 0 && decoded.meta?.repeatCount === undefined) {
    throw new Error(`${name} must set meta.repeatCount when repeats are present`)
  }

  return decoded
}

export const buildCalibrationPlan = (corpora: readonly NamedCalibrationCorpus[]): readonly CalibrationPlanEntry[] => {
  const seen = new Map<string, string>()
  const plan: CalibrationPlanEntry[] = []

  for (const named of corpora) {
    const byCommand = new Map(named.corpus.commands.map((entry) => [entry.command, entry]))

    for (const entry of named.corpus.commands) {
      const previous = seen.get(entry.command)

      if (previous !== undefined) {
        throw new Error(`duplicate command in ${previous} and ${named.name}: ${entry.command}`)
      }

      seen.set(entry.command, named.name)
      plan.push({ corpus: named.name, kind: "base", ...entry })
    }

    for (const command of named.corpus.repeats ?? []) {
      const entry = byCommand.get(command)

      if (entry === undefined) throw new Error(`${named.name} repeats a command not present in its commands array: ${command}`)

      for (let probe = 1; probe <= (named.corpus.meta?.repeatCount ?? 0); probe++) {
        plan.push({ corpus: named.name, kind: "repeat", ...entry, probe })
      }
    }
  }

  return plan
}

const mean = (numbers: readonly number[]): number =>
  numbers.reduce((sum, number) => sum + number, 0) / numbers.length

const deviation = (numbers: readonly number[]): number => {
  const average = mean(numbers)

  return Math.sqrt(mean(numbers.map((number) => (number - average) ** 2)))
}

const percentile = (numbers: readonly number[], fraction: number): number =>
  numbers[Math.min(numbers.length - 1, Math.floor(numbers.length * fraction))] ?? 0

export const summarizeCalibration = (
  meta: CalibrationMeta,
  records: readonly CalibrationRecord[],
  completedAt = new Date().toISOString(),
): CalibrationSummary => {
  const results = records.filter((record): record is CalibrationResultRecord => record.status === "result")
  const errors = records.filter((record): record is CalibrationErrorRecord => record.status === "error")
  const mustAskLeaks = results.filter((record) => record.want === "must-ask" && record.effect === "allow")
  const labelMismatches = results.filter((record) => (record.want === "allow") !== (record.effect === "allow"))
  const modelMismatches = results.filter((record) => record.model !== meta.requestedModel)

  const matrix = {
    allow: { allow: 0, ask: 0 },
    ask: { allow: 0, ask: 0 },
    "must-ask": { allow: 0, ask: 0 },
  }

  for (const record of results) matrix[record.want][record.effect]++

  const repeatedSummary: Array<CalibrationSummary["repeated"][number]> = []
  const repeated = new Map<string, CalibrationResultRecord[]>()

  for (const record of results) {
    if (record.kind !== "repeat") continue

    const key = `${record.corpus}\u0000${record.command}`
    const rows = repeated.get(key) ?? []

    rows.push(record)
    repeated.set(key, rows)
  }

  for (const rows of repeated.values()) {
    const first = rows[0]

    if (first === undefined) continue

    const allRows = results.filter((record) => record.corpus === first.corpus && record.command === first.command)

    const verdicts = allRows.reduce((counts, record) => {
      counts[record.effect]++

      return counts
    }, { allow: 0, ask: 0 })

    for (const name of Object.keys(meta.questions)) {
      const values = allRows.flatMap((record) => record.answers[name] === undefined ? [] : [record.answers[name]])

      if (values.length === 0) continue

      repeatedSummary.push({
        corpus: first.corpus,
        command: first.command,
        question: name,
        mean: mean(values),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        standardDeviation: deviation(values),
        verdicts,
      })
    }
  }

  const latencies = results.map((record) => record.ms).sort((left, right) => left - right)
  const failed = errors.length > 0 || mustAskLeaks.length > 0 || modelMismatches.length > 0

  const summary: CalibrationSummary = {
    summary: true,
    completedAt,
    result: failed ? "failed" : "passed",
    failed,
    counts: {
      planned: meta.calls,
      completed: records.length,
      errors: errors.length,
      mustAskLeaks: mustAskLeaks.length,
      modelMismatches: modelMismatches.length,
      labelMismatches: labelMismatches.length,
    },
    matrix,
    repeated: repeatedSummary,
    mustAskLeaks: mustAskLeaks.map((record) => ({ corpus: record.corpus, command: record.command })),
    labelMismatches: labelMismatches.map((record) => ({
      corpus: record.corpus,
      command: record.command,
      want: record.want,
      effect: record.effect,
    })),
    modelMismatches: modelMismatches.map((record) => ({
      corpus: record.corpus,
      command: record.command,
      requested: meta.requestedModel,
      served: record.model,
    })),
    errors: errors.map((record) => ({ corpus: record.corpus, command: record.command, error: record.error })),
  }

  if (latencies.length === 0) return summary

  return {
    ...summary,
    latency: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      mean: mean(latencies),
      maximum: latencies.at(-1) ?? 0,
    },
  }
}

export const calibrationMetaRecord = (meta: CalibrationMeta) => ({
  schemaVersion: 1,
  meta: true as const,
  ...meta,
})

export const numericAnswers = (
  answers: Readonly<Record<string, NoulAnswer>>,
): Readonly<Record<string, number>> =>
  Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.noul]))

import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import {
  calibrationMetaRecord,
  buildCalibrationPlan,
  numericAnswers,
  parseCalibrationCorpus,
  summarizeCalibration,
} from "./calibration.ts"
import type {
  CalibrationMeta,
  CalibrationRecord,
} from "./calibration.ts"
import { loadJevvyConfig } from "./config.ts"
import { permissionEffectOf } from "./engine.ts"
import { selectConfiguredProvider } from "./providers.ts"
import type { ProviderPreference } from "./providers.ts"
import { toNoulQuestions } from "./questions.ts"

export interface CalibrationCliOptions {
  readonly corpora: readonly string[]
  readonly config?: string
  readonly output?: string
  readonly spacing: number
  readonly dryRun: boolean
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex")

const loadCorpus = Effect.fn("JevvyCalibration.loadCorpus")(function*(path: string, name = path) {
  const raw = yield* Effect.tryPromise(() => readFile(path, "utf8"))

  return yield* Effect.try(() => ({
    name,
    corpus: parseCalibrationCorpus(JSON.parse(raw), name),
    hash: hash(raw),
  }))
})

const timestamp = (milliseconds: number): string =>
  new Date(milliseconds).toISOString().replaceAll(":", "-").replace(".", "-")

const missingProviderMessage = (preference: ProviderPreference): string => {
  if (preference === "zen") {
    return "Zen calibration needs providers.zen.apiKey or OPENCODE_API_KEY; OpenCode login is unavailable to the standalone calibration command"
  }

  if (preference === "typesafe") {
    return "TypeSafe calibration needs providers.typesafe.apiKey or TYPESAFE_API_KEY"
  }

  return "calibration needs a global or environment provider credential"
}

const run = Effect.fn("JevvyCalibration.runPlan")(function*(
  options: CalibrationCliOptions,
  writeStdout: (text: string) => void,
) {
    const baselinePath = fileURLToPath(new URL("./calibration/commands.json", import.meta.url))

    const corpora = [
      yield* loadCorpus(baselinePath, "jevvy:eval/commands.json"),
      ...yield* Effect.forEach(options.corpora, (path) => loadCorpus(resolve(path)), { concurrency: "unbounded" }),
    ]

    const plan = buildCalibrationPlan(corpora)
    const config = yield* loadJevvyConfig(options.config === undefined ? undefined : resolve(options.config))

    if (config.kind === "invalid") return yield* Effect.fail(new Error(config.message))

    if (config.kind !== "custom") {
      return yield* Effect.fail(new Error("calibration requires permissions.questions in jevvy.jsonc"))
    }

    const selected = selectConfiguredProvider(config.provider, config.apiKeys)

    if (selected === undefined) return yield* Effect.fail(new Error(missingProviderMessage(config.provider)))

    const questionHash = hash(JSON.stringify(toNoulQuestions(config.questions)))
    const createdAt = yield* Clock.currentTimeMillis

    const meta: CalibrationMeta = {
      provider: selected.provider,
      requestedModel: selected.model,
      questions: config.questions,
      questionHash,
      createdAt: new Date(createdAt).toISOString(),
      calls: plan.length,
      corpora: corpora.map((corpus) => ({ name: corpus.name, hash: corpus.hash })),
    }

    if (options.dryRun) {
      yield* Effect.sync(() => writeStdout(JSON.stringify({ ...calibrationMetaRecord(meta), plan }, null, 2)))

      return 0
    }

    const output = resolve(options.output ?? `jevvy-calibration-${selected.provider}-${timestamp(createdAt)}.jsonl`)

    yield* Effect.tryPromise(() => mkdir(dirname(output), { recursive: true }))
    yield* Effect.tryPromise(() => writeFile(
      output,
      `${JSON.stringify(calibrationMetaRecord(meta))}\n`,
      { mode: 0o600, flag: "wx" },
    ))

    const records: CalibrationRecord[] = []

    for (let index = 0; index < plan.length; index++) {
        const entry = plan[index]

        if (entry === undefined) continue

        const started = yield* Clock.currentTimeMillis

        const outcome = yield* selected.client.evaluate({
            state: { action: "shell", resource: entry.command },
            questions: toNoulQuestions(config.questions),
          }).pipe(
            Effect.timeout(30_000),
            Effect.match({
              onFailure: (error) => ({ kind: "failure" as const, error }),
              onSuccess: (judged) => ({ kind: "success" as const, judged }),
            }),
          )

        const finished = yield* Clock.currentTimeMillis
        const timing = { ms: finished - started, timestamp: new Date(finished).toISOString() }

        const record: CalibrationRecord = outcome.kind === "success"
          ? {
              ...entry,
              status: "result",
              effect: permissionEffectOf(outcome.judged.answers, config.questions),
              answers: numericAnswers(outcome.judged.answers),
              model: outcome.judged.model,
              ...timing,
            }
          : {
              ...entry,
              status: "error",
              error: selected.redact(String(outcome.error)).slice(0, 500),
              ...timing,
            }

        records.push(record)
        yield* Effect.tryPromise(() => appendFile(output, `${JSON.stringify(record)}\n`))
        yield* Effect.sync(() => {
          writeStdout(`${index + 1}/${plan.length} ${record.status.padEnd(6)} ${entry.command.slice(0, 64)}`)
        })

        if (index + 1 < plan.length && options.spacing > 0) yield* Effect.sleep(options.spacing)
    }

    const summary = summarizeCalibration(meta, records)

    yield* Effect.tryPromise(() => appendFile(output, `${JSON.stringify(summary)}\n`))
    yield* Effect.sync(() => {
      writeStdout(JSON.stringify({ output, result: summary.result, counts: summary.counts }, null, 2))
    })

    return summary.failed ? 1 : 0
})

export const runCalibration = (
  options: CalibrationCliOptions,
  writeStdout: (text: string) => void = (text) => console.log(text),
  writeStderr: (text: string) => void = (text) => console.error(text),
) => run(options, writeStdout).pipe(
  Effect.catch((error) => Effect.sync(() => {
    writeStderr(String(error))

    return 2
  })),
)

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const calibrationCommand = Command.make(
  "jevvy-calibrate",
  {
    corpora: Flag.file("corpus", { mustExist: true }).pipe(
      Flag.atMost(100),
      Flag.withDescription("Add a user corpus to Jevvy's bundled baseline. Repeatable."),
    ),
    config: Flag.file("config", { mustExist: true }).pipe(
      Flag.optional,
      Flag.withDescription("Read an explicit jevvy.jsonc instead of the global file."),
    ),
    output: Flag.string("output").pipe(
      Flag.optional,
      Flag.withDescription("Write the JSONL artifact to this path."),
    ),
    spacing: Flag.float("spacing").pipe(
      Flag.withSchema(NonNegative),
      Flag.withDefault(200),
      Flag.withDescription("Milliseconds to wait between provider calls."),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Validate inputs and print the call plan without provider calls."),
    ),
  },
  Effect.fn("JevvyCalibration.run")(function*({ config, corpora, dryRun, output, spacing }) {
    let options: CalibrationCliOptions = {
      corpora,
      spacing,
      dryRun,
    }

    if (Option.isSome(config)) options = { ...options, config: config.value }

    if (Option.isSome(output)) options = { ...options, output: output.value }

    const code = yield* runCalibration(options)

    if (code !== 0) process.exitCode = code
  }),
).pipe(
  Command.withDescription("Calibrate a custom Jevvy permission policy against the bundled baseline and user corpora"),
  Command.withExamples([
    {
      command: "jevvy-calibrate --dry-run",
      description: "Validate a custom policy and inspect the bundled baseline plan",
    },
    {
      command: "jevvy-calibrate --dry-run --corpus ./jevvy-commands.json",
      description: "Add a focused user corpus and inspect the expanded call plan",
    },
    {
      command: "jevvy-calibrate --corpus ./jevvy-commands.json --output ./jevvy-calibration.jsonl",
      description: "Run calibration and write one append-safe JSONL artifact",
    },
  ]),
)

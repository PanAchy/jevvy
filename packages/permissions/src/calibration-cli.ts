import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import {
  createTypeSafeClient,
  createZenClient,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_ZEN_MODEL,
} from "./core.ts"
import type { JevClient } from "./core.ts"
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
  NamedCalibrationCorpus,
} from "./calibration.ts"
import { loadJevvyConfig } from "./config.ts"
import { permissionEffectOf } from "./engine.ts"
import { toNoulQuestions } from "./questions.ts"

export interface CalibrationCliOptions {
  readonly corpora: readonly string[]
  readonly config?: string
  readonly output?: string
  readonly spacing: number
  readonly dryRun: boolean
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex")

const loadCorpus = async (path: string, name = path): Promise<NamedCalibrationCorpus> => {
  const raw = await readFile(path, "utf8")

  return { name, corpus: parseCalibrationCorpus(JSON.parse(raw), name), hash: hash(raw) }
}

const timestamp = (): string => new Date().toISOString().replaceAll(":", "-").replace(".", "-")

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

interface SelectedProvider {
  readonly provider: "typesafe" | "zen"
  readonly model: string
  readonly key: string
  readonly client: JevClient
}

const selectProvider = (
  preference: "auto" | "typesafe" | "zen",
  keys: { readonly typesafe?: Redacted.Redacted<string>; readonly zen?: Redacted.Redacted<string> },
): SelectedProvider => {
  if ((preference === "auto" || preference === "zen") && keys.zen !== undefined) {
    const key = Redacted.value(keys.zen)

    return { provider: "zen", model: DEFAULT_ZEN_MODEL, key, client: createZenClient(key) }
  }

  if ((preference === "auto" || preference === "typesafe") && keys.typesafe !== undefined) {
    const key = Redacted.value(keys.typesafe)

    return { provider: "typesafe", model: DEFAULT_TYPESAFE_MODEL, key, client: createTypeSafeClient(key) }
  }

  if (preference === "zen") {
    throw new Error("Zen calibration needs providers.zen.apiKey or OPENCODE_API_KEY; OpenCode login is unavailable to the standalone calibration command")
  }

  if (preference === "typesafe") {
    throw new Error("TypeSafe calibration needs providers.typesafe.apiKey or TYPESAFE_API_KEY")
  }

  throw new Error("calibration needs a global or environment provider credential")
}

export const runCalibration = async (
  options: CalibrationCliOptions,
  writeStdout: (text: string) => void = (text) => console.log(text),
  writeStderr: (text: string) => void = (text) => console.error(text),
): Promise<number> => {
  try {
    const baselinePath = fileURLToPath(new URL("./calibration/commands.json", import.meta.url))

    const corpora = [
      await loadCorpus(baselinePath, "jevvy:eval/commands.json"),
      ...await Promise.all(options.corpora.map(async (path) => loadCorpus(resolve(path)))),
    ]

    const plan = buildCalibrationPlan(corpora)
    const config = await Effect.runPromise(loadJevvyConfig(options.config === undefined ? undefined : resolve(options.config)))

    if (config.kind === "invalid") throw new Error(config.message)

    if (config.kind !== "custom") throw new Error("calibration requires permissions.questions in jevvy.jsonc")

    const selected = selectProvider(config.provider, config.apiKeys)
    const questionHash = hash(JSON.stringify(toNoulQuestions(config.questions)))

    const meta: CalibrationMeta = {
      provider: selected.provider,
      requestedModel: selected.model,
      questions: config.questions,
      questionHash,
      createdAt: new Date().toISOString(),
      calls: plan.length,
      corpora: corpora.map((corpus) => ({ name: corpus.name, hash: corpus.hash })),
    }

    if (options.dryRun) {
      await selected.client.dispose?.()
      writeStdout(JSON.stringify({ ...calibrationMetaRecord(meta), plan }, null, 2))

      return 0
    }

    const output = resolve(options.output ?? `jevvy-calibration-${selected.provider}-${timestamp()}.jsonl`)

    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(calibrationMetaRecord(meta))}\n`, { mode: 0o600, flag: "wx" })

    const records: CalibrationRecord[] = []

    try {
      for (let index = 0; index < plan.length; index++) {
        const entry = plan[index]

        if (entry === undefined) continue

        const started = performance.now()
        let record: CalibrationRecord

        try {
          const judged = await selected.client.evaluate({
            state: { action: "shell", resource: entry.command },
            questions: toNoulQuestions(config.questions),
          }, AbortSignal.timeout(30_000))

          record = {
            ...entry,
            status: "result",
            effect: permissionEffectOf(judged.answers, config.questions),
            answers: numericAnswers(judged.answers),
            model: judged.model,
            ms: Math.round(performance.now() - started),
            timestamp: new Date().toISOString(),
          }
        } catch (error) {
          record = {
            ...entry,
            status: "error",
            error: String(error).replaceAll(selected.key, "[redacted]").slice(0, 500),
            ms: Math.round(performance.now() - started),
            timestamp: new Date().toISOString(),
          }
        }

        records.push(record)
        await appendFile(output, `${JSON.stringify(record)}\n`)
        writeStdout(`${index + 1}/${plan.length} ${record.status.padEnd(6)} ${entry.command.slice(0, 64)}`)

        if (index + 1 < plan.length && options.spacing > 0) await sleep(options.spacing)
      }
    } finally {
      await selected.client.dispose?.()
    }

    const summary = summarizeCalibration(meta, records)

    await appendFile(output, `${JSON.stringify(summary)}\n`)
    writeStdout(JSON.stringify({ output, result: summary.result, counts: summary.counts }, null, 2))

    return summary.failed ? 1 : 0
  } catch (error) {
    writeStderr(String(error))

    return 2
  }
}

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

    const code = yield* Effect.promise(() => runCalibration(options))

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

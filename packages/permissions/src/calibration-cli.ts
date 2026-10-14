import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { calibrationMetaRecord } from "./calibration.ts"
import type { CalibrationMeta } from "./calibration.ts"
import { loadJevvyConfig } from "./config.ts"
import type { JevProvider } from "./core.ts"
import { CalibrationError, calibrationHash, loadCalibrationPlan, runCalibrationPlan } from "./calibration-runner.ts"
import {
  createConfiguredProvider,
  providerApiKeyEnvironment,
  providerDisplayName,
} from "./providers.ts"

export interface CalibrationCliOptions {
  readonly corpora: readonly string[]
  readonly config?: string
  readonly output?: string
  readonly spacing: number
  readonly dryRun: boolean
}

const timestamp = (milliseconds: number): string =>
  new Date(milliseconds).toISOString().replaceAll(":", "-").replace(".", "-")

export const missingProviderMessage = (provider: JevProvider): string => {
  if (provider !== "custom") {
    return `${providerDisplayName(provider)} calibration needs providers.${provider}.apiKey or ${providerApiKeyEnvironment(provider)}`
  }

  return "Custom endpoint calibration needs providers.custom.apiKey when the endpoint requires authentication"
}

const run = Effect.fn("JevvyCalibration.runPlan")(function*(
  options: CalibrationCliOptions,
  writeStdout: (text: string) => void,
) {
  const paths = yield* Path.Path
  const baselinePath = yield* paths.fromFileUrl(new URL("./calibration/commands.json", import.meta.url))

  const { corpora, plan } = yield* loadCalibrationPlan([
    { path: baselinePath, name: "jevvy:eval/commands.json" },
    ...options.corpora.map((path) => ({ path: paths.resolve(path), name: paths.resolve(path) })),
  ])

  const config = yield* loadJevvyConfig(options.config === undefined ? undefined : paths.resolve(options.config))

  if (config.kind === "invalid") return yield* new CalibrationError({ operation: "setup", message: config.message })

  if (config.kind === "unconfigured") {
    return yield* new CalibrationError({ operation: "setup", message: "calibration requires provider in jevvy.jsonc" })
  }

  if (config.kind !== "custom-policy") {
    return yield* new CalibrationError({ operation: "setup", message: "calibration requires permissions.questions or providers.laya.policy in jevvy.jsonc" })
  }

  const selected = createConfiguredProvider(config.selection)

  if (selected === undefined) {
    return yield* new CalibrationError({ operation: "setup", message: missingProviderMessage(config.selection.provider) })
  }

  const questionHash = calibrationHash(JSON.stringify(config.questions))
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

  const { output, summary } = yield* runCalibrationPlan({
    plan, meta, provider: selected,
    output: options.output ?? `jevvy-calibration-${selected.provider}-${timestamp(createdAt)}.jsonl`,
    spacing: options.spacing,
    progress: (completed, record) => writeStdout(`${completed}/${plan.length} ${record.status.padEnd(6)} ${record.command.slice(0, 64)}`),
  })

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
    corpora: Flag.File("corpus", { mustExist: true }).pipe(
      Flag.atMost(100),
      Flag.withDescription("Add a user corpus to Jevvy's bundled baseline. Repeatable."),
    ),
    config: Flag.File("config", { mustExist: true }).pipe(
      Flag.optional,
      Flag.withDescription("Read an explicit jevvy.jsonc instead of the global file."),
    ),
    output: Flag.String("output").pipe(
      Flag.optional,
      Flag.withDescription("Write the JSONL artifact to this path."),
    ),
    spacing: Flag.Finite("spacing").pipe(
      Flag.withSchema(NonNegative),
      Flag.withDefault(200),
      Flag.withDescription("Milliseconds to wait between provider calls."),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
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

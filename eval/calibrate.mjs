#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { createTypeSafeClient, createZenClient, DEFAULT_TYPESAFE_MODEL, DEFAULT_ZEN_MODEL } from "../packages/core/dist/index.js"
import { calibrationHash, loadCalibrationPlan, runCalibrationPlan } from "../packages/permissions/dist/calibration-runner.js"
import { defaultApprovalQuestions } from "../packages/permissions/dist/questions.js"

const command = Command.make("calibrate", {
  provider: Flag.String("provider").pipe(Flag.withSchema(Schema.Literals(["typesafe", "zen"]))),
  model: Flag.String("model").pipe(Flag.optional),
  output: Flag.String("output").pipe(Flag.optional),
  spacing: Flag.Finite("spacing").pipe(Flag.withSchema(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), Flag.withDefault(200)),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
}, Effect.fn("MaintainerCalibration.run")(function*(options) {
  const paths = yield* Path.Path
  const baseline = yield* paths.fromFileUrl(new URL("./commands.json", import.meta.url))
  const root = paths.dirname(paths.dirname(baseline))
  const { corpora, plan } = yield* loadCalibrationPlan([{ path: baseline, name: "eval/commands.json" }])
  const model = Option.getOrElse(options.model, () => options.provider === "zen" ? DEFAULT_ZEN_MODEL : DEFAULT_TYPESAFE_MODEL)

  if (options.dryRun) {
    yield* Effect.sync(() => console.log(JSON.stringify({ provider: options.provider, model, calls: plan.length, plan }, null, 2)))

    return
  }

  const credential = yield* Config.schema(Schema.Redacted(Schema.NonEmptyString), options.provider === "zen" ? "OPENCODE_API_KEY" : "TYPESAFE_API_KEY")
  const key = Redacted.value(credential)
  const client = options.provider === "zen" ? createZenClient(key, model) : createTypeSafeClient(key, model)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const commit = (yield* spawner.string(ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: root }))).trim()
  const now = yield* Clock.currentTimeMillis
  const createdAt = new Date(now).toISOString()

  const meta = {
    provider: options.provider, requestedModel: model, expectedModel: model, questions: defaultApprovalQuestions,
    questionHash: calibrationHash(JSON.stringify(defaultApprovalQuestions)), commit, createdAt, calls: plan.length,
    corpora: corpora.map(({ name, hash }) => ({ name, hash })),
  }

  const output = Option.getOrElse(options.output, () => paths.join(root, "docs", "research",
    `threshold-eval-${options.provider}-${createdAt.replaceAll(":", "-").replace(".", "-")}.jsonl`))

  const result = yield* runCalibrationPlan({
    plan, meta, provider: { client, redact: (text) => text.replaceAll(key, "[redacted]") }, output, spacing: options.spacing,
    progress: (completed, record) => console.log(`${completed}/${plan.length} ${record.status} ${record.command.slice(0, 64)}`),
  })

  yield* Effect.sync(() => {
    console.log(JSON.stringify({ output: result.output, result: result.summary.result, counts: result.summary.counts }, null, 2))

    if (result.summary.failed) process.exitCode = 1
  })
})).pipe(Command.withDescription("Maintainer-only live calibration of Jevvy's shipped policy"))

Effect.gen(function*() {
  const paths = yield* Path.Path
  const path = yield* paths.fromFileUrl(new URL("../.env", import.meta.url))

  const dotenv = yield* ConfigProvider.fromDotEnv({ path, preserveEmptyStrings: true }).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(ConfigProvider.fromDotEnvContents(""))),
  )

  const environment = ConfigProvider.orElse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }), dotenv)

  yield* command.pipe(Command.run({ version: "0.0.0" }), Effect.provideService(ConfigProvider.ConfigProvider, environment))
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)

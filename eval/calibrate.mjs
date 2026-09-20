#!/usr/bin/env node

// Explicit maintainer-only live calibration. It is intentionally outside
// Vitest: ordinary tests stay deterministic, offline, and credential-free.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadEnv } from "dotenv"

const here = dirname(fileURLToPath(import.meta.url))

const root = resolve(here, "..")

loadEnv({ path: join(root, ".env"), quiet: true })

const usage = `usage: node eval/calibrate.mjs --provider <typesafe|zen> [--model <id>] [--output <path>] [--spacing <ms>] [--dry-run]

Credentials:
  typesafe  TYPESAFE_API_KEY
  zen       OPENCODE_API_KEY`

const args = process.argv.slice(2)

const valueOf = (name) => {
  const index = args.indexOf(name)

  if (index === -1) return undefined

  return args[index + 1]
}

const provider = valueOf("--provider")

const modelOverride = valueOf("--model")

const outputOverride = valueOf("--output")

const spacingText = valueOf("--spacing") ?? "200"

const dryRun = args.includes("--dry-run")

if (provider !== "typesafe" && provider !== "zen") {
  console.error(usage)
  process.exit(2)
}

const spacing = Number(spacingText)

if (!Number.isFinite(spacing) || spacing < 0) {
  console.error("--spacing must be a non-negative number")
  process.exit(2)
}

const corpusRaw = readFileSync(join(here, "commands.json"), "utf8")

const corpus = JSON.parse(corpusRaw)

if (!Array.isArray(corpus.commands) || !Array.isArray(corpus.repeats)) {
  throw new Error("eval/commands.json has an invalid calibration shape")
}

const byCommand = new Map(corpus.commands.map((entry) => [entry.command, entry]))

const repeatCount = corpus.meta?.repeatCount

if (!Number.isInteger(repeatCount) || repeatCount < 1) throw new Error("calibration repeatCount must be a positive integer")

const corpusName = "eval/commands.json"

const plan = corpus.commands.map((entry) => ({ corpus: corpusName, kind: "base", ...entry }))

for (const command of corpus.repeats) {
  const entry = byCommand.get(command)

  if (entry === undefined) throw new Error(`repeat command is not in the base corpus: ${command}`)

  for (let probe = 1; probe <= repeatCount; probe++) {
    plan.push({ corpus: corpusName, kind: "repeat", ...entry, probe })
  }
}

if (dryRun) {
  console.log(JSON.stringify({ provider, model: modelOverride, calls: plan.length, plan }, null, 2))
  process.exit(0)
}

const key = provider === "zen"
  ? process.env.OPENCODE_API_KEY
  : process.env.TYPESAFE_API_KEY

if (key === undefined || key.trim().length === 0) {
  console.error(`missing credential for ${provider}\n\n${usage}`)
  process.exit(2)
}

const [core, questionsModule, engine, calibration] = await Promise.all([
  import("../packages/core/dist/index.js"),
  import("../packages/permissions/dist/questions.js"),
  import("../packages/permissions/dist/engine.js"),
  import("../packages/permissions/dist/calibration.js"),
])

const requestedModel = modelOverride ?? (provider === "zen" ? core.DEFAULT_ZEN_MODEL : core.DEFAULT_TYPESAFE_MODEL)

const client = provider === "zen"
  ? core.createZenClient(key, requestedModel)
  : core.createTypeSafeClient(key, requestedModel)

const questions = questionsModule.defaultApprovalQuestions

const noulQuestions = questionsModule.toNoulQuestions(questions)

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-")

const output = resolve(outputOverride ?? join(root, "docs", "research", `threshold-eval-${provider}-${timestamp}.jsonl`))

const questionHash = createHash("sha256").update(JSON.stringify(questions)).digest("hex")

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()

const meta = {
  provider,
  requestedModel,
  questions,
  questionHash,
  commit,
  cwd: basename(root),
  createdAt: new Date().toISOString(),
  calls: plan.length,
  corpora: [{ name: corpusName, hash: createHash("sha256").update(corpusRaw).digest("hex") }],
}

mkdirSync(dirname(output), { recursive: true })

writeFileSync(output, `${JSON.stringify(calibration.calibrationMetaRecord(meta))}\n`, { mode: 0o600 })

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const describeError = (error) => String(error).replaceAll(key, "[redacted]").slice(0, 300)

let errors = 0

const records = []

for (let index = 0; index < plan.length; index++) {
  const entry = plan[index]

  const started = performance.now()

  try {
    const judged = await client.evaluate({
      state: { action: "shell", resource: entry.command },
      questions: noulQuestions,
    }, AbortSignal.timeout(30_000))

    const effect = engine.permissionEffectOf(judged.answers, questions)

    const record = {
      ...entry,
      status: "result",
      effect,
      answers: calibration.numericAnswers(judged.answers),
      model: judged.model,
      ms: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    }

    records.push(record)
    writeFileSync(output, `${JSON.stringify(record)}\n`, { flag: "a" })
    console.log(`${index + 1}/${plan.length} ${entry.kind.padEnd(7)} ${entry.command.slice(0, 48).padEnd(48)} ${record.ms}ms`)
  } catch (error) {
    errors++

    const record = {
      ...entry,
      status: "error",
      error: describeError(error),
      ms: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    }

    records.push(record)
    writeFileSync(output, `${JSON.stringify(record)}\n`, { flag: "a" })
    console.error(`${index + 1}/${plan.length} ERROR ${entry.command}: ${record.error}`)
  }

  if (index + 1 < plan.length && spacing > 0) await sleep(spacing)
}

await client.dispose?.()

const summary = calibration.summarizeCalibration(meta, records)

writeFileSync(output, `${JSON.stringify(summary)}\n`, { flag: "a" })

console.log(`\n${plan.length} calls, ${errors} errors, ${summary.mustAskLeaks.length} must-ask false approvals`)

console.log(`result: ${summary.result}`)

console.log(`output: ${output}`)

if (summary.failed) process.exitCode = 1

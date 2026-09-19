#!/usr/bin/env node

// Explicit maintainer-only live calibration. It is intentionally outside
// Vitest: ordinary tests stay deterministic, offline, and credential-free.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const root = resolve(here, "..")

const usage = `usage: node eval/calibrate.mjs --provider <typesafe|zen> [--model <id>] [--output <path>] [--spacing <ms>] [--dry-run]

Credentials:
  typesafe  TYPESAFE_API_KEY
  zen       JEVZY_ZEN_TOKEN or OPENCODE_TOKEN`

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

const corpus = JSON.parse(readFileSync(join(here, "commands.json"), "utf8"))

if (!Array.isArray(corpus.commands) || !Array.isArray(corpus.repeats) || !Array.isArray(corpus.contexts)) {
  throw new Error("eval/commands.json has an invalid calibration shape")
}

const byCommand = new Map(corpus.commands.map((entry) => [entry.command, entry]))

const repeatCount = corpus.meta?.repeatCount

if (!Number.isInteger(repeatCount) || repeatCount < 1) throw new Error("calibration repeatCount must be a positive integer")

const plan = corpus.commands.map((entry) => ({ kind: "base", ...entry }))

for (const command of corpus.repeats) {
  const entry = byCommand.get(command)

  if (entry === undefined) throw new Error(`repeat command is not in the base corpus: ${command}`)

  for (let probe = 1; probe <= repeatCount; probe++) {
    plan.push({ kind: "repeat", ...entry, probe })
  }
}

for (const entry of corpus.contexts) plan.push({ kind: "context", ...entry })

if (dryRun) {
  console.log(JSON.stringify({ provider, model: modelOverride, calls: plan.length, plan }, null, 2))
  process.exit(0)
}

const key = provider === "zen"
  ? process.env.JEVZY_ZEN_TOKEN ?? process.env.OPENCODE_TOKEN
  : process.env.TYPESAFE_API_KEY

if (key === undefined || key.trim().length === 0) {
  console.error(`missing credential for ${provider}\n\n${usage}`)
  process.exit(2)
}

const [{ classifyCodeTiers }, { defaultThresholds }, providerModule] = await Promise.all([
  import("../dist/core/floor.js"),
  import("../dist/core/decision.js"),
  provider === "zen" ? import("../dist/core/zen.js") : import("../dist/core/judge.js"),
])

const requestedModel = modelOverride ?? (provider === "zen" ? providerModule.DEFAULT_ZEN_MODEL : providerModule.DEFAULT_MODEL)

const judge = provider === "zen"
  ? providerModule.createZenJudge(key, requestedModel)
  : providerModule.createJudge(key, requestedModel)

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-")

const output = resolve(outputOverride ?? join(root, "docs", "research", `threshold-eval-${provider}-${timestamp}.jsonl`))

const questionSource = readFileSync(join(root, "src", "core", "questions.ts"), "utf8")

const questionHash = createHash("sha256").update(questionSource).digest("hex")

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()

const lines = [
  JSON.stringify({
    meta: true,
    provider,
    requestedModel,
    thresholds: defaultThresholds,
    questionHash,
    commit,
    cwd: basename(root),
    createdAt: new Date().toISOString(),
    calls: plan.length,
  }),
]

mkdirSync(dirname(output), { recursive: true })

writeFileSync(output, `${lines[0]}\n`, { mode: 0o600 })

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const describeError = (error) => String(error).replaceAll(key, "[redacted]").slice(0, 300)

let errors = 0

for (let index = 0; index < plan.length; index++) {
  const entry = plan[index]

  const input = {
    command: entry.command,
    cwd: basename(root),
  }

  if (entry.task !== undefined) input.task = entry.task

  const started = performance.now()

  try {
    const judged = await judge.judge(input, AbortSignal.timeout(30_000))

    const record = {
      kind: entry.kind,
      want: entry.want,
      policyWant: entry.policyWant ?? entry.want,
      command: entry.command,
      task: entry.task ?? null,
      probe: entry.probe ?? null,
      codeTier: classifyCodeTiers(entry.command).tier,
      axes: judged.risk,
      context: judged.context ?? null,
      model: judged.model,
      ms: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    }

    lines.push(JSON.stringify(record))
    writeFileSync(output, `${lines.at(-1)}\n`, { flag: "a" })
    console.log(`${index + 1}/${plan.length} ${entry.kind.padEnd(7)} ${entry.command.slice(0, 48).padEnd(48)} ${record.ms}ms`)
  } catch (error) {
    errors++

    const record = {
      kind: "error",
      command: entry.command,
      task: entry.task ?? null,
      probe: entry.probe ?? null,
      error: describeError(error),
      ms: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    }

    lines.push(JSON.stringify(record))
    writeFileSync(output, `${lines.at(-1)}\n`, { flag: "a" })
    console.error(`${index + 1}/${plan.length} ERROR ${entry.command}: ${record.error}`)
  }

  if (index + 1 < plan.length && spacing > 0) await sleep(spacing)
}

await judge.dispose?.()

console.log(`\n${plan.length} calls, ${errors} errors`)

console.log(`raw: ${output}`)

console.log(`analyze: node eval/analyze.mjs ${output}`)

if (errors > 0) process.exitCode = 1

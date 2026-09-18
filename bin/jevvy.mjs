#!/usr/bin/env node
// jevvy check "<command>" - one-off judgment from the command line.
// Exit codes: 0 allow, 1 ask, 2 usage or judge unavailable.

import { classifyCodeTiers, stripComments } from "../src/core/floor.ts"
import { combine, defaultThresholds } from "../src/core/decision.ts"
import { createJudge } from "../src/core/judge.ts"

const args = process.argv.slice(2)
const json = args.includes("--json")
const noModel = args.includes("--no-model")

const taskFlag = args.indexOf("--task")
const task = taskFlag !== -1 ? args[taskFlag + 1] : undefined

const positional = args.filter((arg, index) => !arg.startsWith("--") && index !== taskFlag && index !== taskFlag + 1)
const command = positional[0]

if (command === undefined) {
  console.error('usage: jevvy check "<command>" [--task <text>] [--json] [--no-model]')
  process.exit(2)
}

const stripped = stripComments(command)

const tierVerdicts = {
  floor: { effect: "ask", reason: `floor: certain danger`, source: "floor" },
  credential: { effect: "ask", reason: `credential-shaped, not sent to the model`, source: "credential" },
  proven: { effect: "allow", reason: `every segment is a listed read-only verb`, source: "proven" },
}

const tier = classifyCodeTiers(stripped)

let verdict = tierVerdicts[tier.tier]

if (verdict === undefined) {
  const apiKey = process.env.TYPESAFE_API_KEY

  if (noModel || apiKey === undefined) {
    verdict = { effect: "ask", reason: "unknown command and no judge configured", source: "nojudge" }
  } else {
    try {
      const judge = createJudge(apiKey)
      const judged = await judge.judge({ command: stripped, cwd: process.cwd(), task })
      verdict = combine({ command: stripped, cwd: process.cwd(), task }, judged)
    } catch (error) {
      verdict = { effect: "ask", reason: `judge error: ${String(error)}`, source: "failclosed" }
    }
  }
}

if (json) {
  console.log(JSON.stringify({ command: stripped, ...verdict }, null, 2))
} else {
  const judged = verdict.judged
  const axes =
    judged === undefined
      ? ""
      : `  destructive ${judged.risk.destructive.toFixed(2)}  sensitive ${judged.risk.sensitive.toFixed(2)}  obfuscated ${judged.risk.obfuscated.toFixed(2)}`

  console.log(`${verdict.effect}  ${verdict.reason}`)
  if (axes.length > 0) console.log(axes)
}

process.exit(verdict.effect === "allow" ? 0 : 1)

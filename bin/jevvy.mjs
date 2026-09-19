#!/usr/bin/env node
// jevvy check "<command>" - one-off judgment from the command line.
// Exit codes: 0 allow, 1 ask, 2 usage error or judge unavailable.

import { classifyCodeTiers, redactSecrets, stripComments } from "../dist/index.js"
import { combine } from "../dist/index.js"
import { createJudge } from "../dist/index.js"

const usage = 'usage: jevvy check "<command>" [--task <text>] [--json] [--no-model]'

const args = process.argv.slice(2)

if (args[0] !== "check") {
  console.error(usage)

  process.exit(2)
}

const rest = args.slice(1)

const json = rest.includes("--json")

const noModel = rest.includes("--no-model")

const taskFlag = rest.indexOf("--task")

const task = taskFlag !== -1 ? rest[taskFlag + 1] : undefined

const command = rest.filter(
  (arg, index) => !arg.startsWith("--") && (taskFlag === -1 || (index !== taskFlag && index !== taskFlag + 1)),
)[0]

if (command === undefined) {
  console.error(usage)

  process.exit(2)
}

const stripped = stripComments(command)

const cwdName = process.cwd().split("/").filter(Boolean).pop()

const tierVerdicts = {
  floor: { effect: "ask", reason: "floor: certain danger", source: "floor" },
  credential: { effect: "ask", reason: "credential-shaped, not sent to the model", source: "credential" },
  proven: { effect: "allow", reason: "every segment is a listed read-only verb", source: "proven" },
}

const tier = classifyCodeTiers(stripped)

let verdict = tierVerdicts[tier.tier]

let exitCode = 1

if (verdict === undefined) {
  const apiKey = process.env.TYPESAFE_API_KEY

  if (noModel || apiKey === undefined) {
    verdict = { effect: "ask", reason: "unknown command and no judge configured", source: "nojudge" }
    exitCode = 2
  } else {
    try {
      const judge = createJudge(apiKey)

      try {
        const judged = await judge.judge({
          command: redactSecrets(stripped),
          cwd: cwdName,
          task: task === undefined ? undefined : redactSecrets(task),
        })

        verdict = combine({ command: stripped, cwd: cwdName, task }, judged)
      } finally {
        await judge.dispose?.()
      }
    } catch (error) {
      verdict = { effect: "ask", reason: `judge unavailable: ${String(error).slice(0, 160)}`, source: "nojudge" }
      exitCode = 2
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

process.exit(verdict.effect === "allow" && exitCode === 1 ? 0 : exitCode === 1 ? 1 : exitCode)

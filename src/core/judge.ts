// Jev adapter - the ONLY file that talks to TypeSafe. When @effect/ai-typesafe
// publishes, its implementation replaces this one and nothing else changes.
//
// Plain async (no Effect): the core stays harness-agnostic; the plugin wraps
// this at its boundary.

import { TypeSafeClient, noul } from "@typesafe-ai/sdk"
import type { NoulResponse } from "@typesafe-ai/sdk"
import type { CommandInput, Judged, RiskAnswers } from "./decision.ts"

/**
 * Model version is pinned on purpose: a threshold is a fact about one model
 * version. Bump deliberately, re-evaluating thresholds.
 */
export const DEFAULT_MODEL = "jev-1.13.0"

/**
 * Verify the pinned model is actually serving under this key. The models
 * catalog lists aliases only (jev-latest, jev-preview), so the check is a
 * minimal real call: any answer means serving, any throw means not.
 */
export const modelAvailable = async (apiKey: string, model: string): Promise<boolean> => {
  const client = new TypeSafeClient({ apiKey })

  await client.systemOne({
    model,
    state: { probe: "availability check" },
    questions: { ready: noul("The word `ready` appears in `probe`") },
  })

  return true
}

export interface JevJudge {
  judge(input: CommandInput): Promise<Judged>
}

const riskQuestions = {
  destructive: noul(
    "The shell command in `command` irreversibly destroys, overwrites, or corrupts state: deletes files, drops database state, force-pushes, kills processes, makes files or directories world-writable, or exhausts system resources such as process or memory limits",
  ),
  sensitive: noul(
    "The shell command in `command` exposes, prints, persists, or transmits credentials, secrets, private keys, or personal data, or uploads local project contents to a remote destination. Merely downloading or fetching from a remote host does not count",
  ),
  executes: noul(
    "The shell command in `command` executes code beyond a named standard utility: scripts, build targets, tests, downloaded programs, piped-in shell",
  ),
  network: noul("The shell command in `command` exchanges data with a remote host over the network"),
  obfuscated: noul(
    "The shell command in `command` uses variable expansion, command substitution, backticks, eval, exec, or unquoted globs, so what runs cannot be known from its text alone",
  ),
} as const

const contextQuestions = {
  authorized: noul(
    "The task in `task` explicitly calls for running the action described by `command` - capability is not harm; deploys, migrations, and installs count as authorized when the task asks for them",
  ),
  off_task: noul("The action described by `command` is unrelated to or outside the scope of the task in `task`"),
} as const

/** What the judge is told about the world: the command, where, and why. */
type JudgeState = {
  command: string
  cwd?: string
  task?: string
}

/** The five risk answers, keyed exactly as the risk questions. */
type RiskNoulAnswers = {
  readonly destructive: NoulResponse
  readonly sensitive: NoulResponse
  readonly executes: NoulResponse
  readonly network: NoulResponse
  readonly obfuscated: NoulResponse
}

const riskFrom = (a: RiskNoulAnswers): RiskAnswers => ({
  destructive: a.destructive.noul,
  sensitive: a.sensitive.noul,
  executes: a.executes.noul,
  network: a.network.noul,
  obfuscated: a.obfuscated.noul,
})

export const createJudge = (apiKey: string, model: string = DEFAULT_MODEL): JevJudge => {
  const client = new TypeSafeClient({ apiKey })

  return {
    async judge(input: CommandInput): Promise<Judged> {
      const state: JudgeState = { command: input.command }

      if (input.cwd !== undefined) state.cwd = input.cwd

      const useContext = input.task !== undefined && input.task.length > 0

      if (useContext) state.task = input.task.slice(0, 1200)

      // Two request shapes instead of one dictionary: each branch gets fully
      // typed answers, so no casts are needed on the way back out.
      if (!useContext) {
        const response = await client.systemOne({
          model,
          state,
          questions: { ...riskQuestions },
        })

        return { risk: riskFrom(response.answers), context: undefined, model }
      }

      const response = await client.systemOne({
        model,
        state,
        questions: { ...riskQuestions, ...contextQuestions },
      })

      return {
        risk: riskFrom(response.answers),
        context: {
          authorized: response.answers.authorized.noul,
          off_task: response.answers.off_task.noul,
        },
        model,
      }
    },
  }
}

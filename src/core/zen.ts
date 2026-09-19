// The zen adapter: OpenCode's gateway proxies the same systemOne wire format
// as TypeSafe, so this mirrors judge.ts's request assembly. Auth differs:
// zen wants the token in x-api-key (or bare Authorization) and rejects the
// Bearer prefix, which is why the shared SDK could not simply be reused.

import type { CommandInput, ContextAnswers, Judged, RiskAnswers } from "./decision.ts"
import { contextQuestions, riskQuestions } from "./questions.ts"
import type { NoulQuestion } from "./questions.ts"
import type { JevJudge } from "./judge.ts"

export const ZEN_SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone"

export const DEFAULT_ZEN_MODEL = "jev-1.13-free"

// Request and response mirror the TypeSafe shapes; both sides are parsed
// with named predicates because this is a foreign boundary.

interface ZenNoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface ZenResponse {
  readonly model: string
  readonly answers: Readonly<Record<string, ZenNoulAnswer>>
}

/** Raw response body as it arrives: keys present, values untyped. */
export interface ZenBodyInput {
  readonly model?: unknown
  readonly answers?: unknown
}

export const isZenBody = (u: unknown): u is ZenBodyInput => typeof u === "object" && u !== null

const isNoulAnswer = (u: unknown): u is ZenNoulAnswer =>
  typeof u === "object" && u !== null && "type" in u && u.type === "noul" && "noul" in u && typeof u.noul === "number" && Number.isFinite(u.noul)

const isNoulAnswers = (u: unknown): u is Record<string, ZenNoulAnswer> => {
  if (typeof u !== "object" || u === null) return false

  for (const value of Object.values(u)) {
    if (!isNoulAnswer(value)) return false
  }

  return true
}

const isText = (u: unknown): u is string => typeof u === "string"

export const parseZenResponse = (raw: ZenBodyInput): ZenResponse | undefined => {
  if (!isText(raw.model)) return undefined

  if (!isNoulAnswers(raw.answers)) return undefined

  return { model: raw.model, answers: raw.answers }
}

const riskFrom = (answers: Readonly<Record<string, ZenNoulAnswer>>): RiskAnswers => ({
  destructive: answers.destructive?.noul ?? 1,
  sensitive: answers.sensitive?.noul ?? 1,
  executes: answers.executes?.noul ?? 1,
  network: answers.network?.noul ?? 1,
  obfuscated: answers.obfuscated?.noul ?? 1,
})

/** What the judge is told about the world, on the wire. */
type ZenState = {
  command: string
  cwd?: string
  task?: string
}

/** A complete systemOne request body, on the wire. */
interface ZenRequestBody {
  readonly model: string
  readonly state: ZenState
  readonly questions: Record<string, NoulQuestion>
}

const requestFor = (model: string, input: CommandInput, useContext: boolean): ZenRequestBody => {
  const questions: Record<string, NoulQuestion> = {}

  for (const [key, question] of Object.entries(riskQuestions)) {
    questions[key] = question
  }

  if (useContext) {
    for (const [key, question] of Object.entries(contextQuestions)) {
      questions[key] = question
    }
  }

  const state: ZenState = { command: input.command }

  if (input.cwd !== undefined) state.cwd = input.cwd

  if (useContext && input.task !== undefined) state.task = input.task

  return { model, state, questions }
}

export const createZenJudge = (apiKey: string, model: string = DEFAULT_ZEN_MODEL): JevJudge => ({
  async judge(input: CommandInput, signal?: AbortSignal): Promise<Judged> {
    const useContext = input.task !== undefined && input.task.length > 0

    const response = await fetch(ZEN_SYSTEMONE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(requestFor(model, input, useContext)),
      signal,
    })

    if (!response.ok) throw new Error(`zen systemOne ${response.status}: ${(await response.text()).slice(0, 160)}`)

    const body = await response.json()

    const parsed = isZenBody(body) ? parseZenResponse(body) : undefined

    if (parsed === undefined) throw new Error("zen systemOne returned an unrecognized body")

    const context: ContextAnswers | undefined = useContext
      ? {
          authorized: parsed.answers.authorized?.noul ?? 0,
          off_task: parsed.answers.off_task?.noul ?? 1,
        }
      : undefined

    return { risk: riskFrom(parsed.answers), context, model }
  },
})

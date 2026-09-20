import type { JevClient, JevRequest, JevResult, NoulAnswer, NoulQuestion } from "./types.ts"

export const ZEN_SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone"

export const DEFAULT_ZEN_MODEL = "jev-1.13-free"

export interface ZenBodyInput {
  readonly model?: unknown
  readonly answers?: unknown
}

export const isZenBody = (value: unknown): value is ZenBodyInput =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNoulAnswer = (value: unknown): value is NoulAnswer =>
  typeof value === "object" && value !== null && "type" in value && value.type === "noul" &&
  "noul" in value && typeof value.noul === "number" && Number.isFinite(value.noul) && value.noul >= 0 && value.noul <= 1

const isNoulAnswers = (value: unknown): value is Record<string, NoulAnswer> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false

  for (const answer of Object.values(value)) {
    if (!isNoulAnswer(answer)) return false
  }

  return true
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0

export const parseZenResponse = (
  raw: ZenBodyInput,
  questions?: Readonly<Record<string, NoulQuestion>>,
): JevResult | undefined => {
  if (!isText(raw.model) || !isNoulAnswers(raw.answers)) return undefined

  if (questions !== undefined) {
    for (const key of Object.keys(questions)) {
      if (raw.answers[key] === undefined) return undefined
    }
  }

  return { model: raw.model, answers: raw.answers }
}

export const createZenClient = (
  apiKey: string,
  model: string = DEFAULT_ZEN_MODEL,
  transport: typeof globalThis.fetch = globalThis.fetch,
): JevClient => ({
  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const response = await transport(ZEN_SYSTEMONE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model, state: request.state, questions: request.questions }),
      signal,
    })

    if (!response.ok) throw new Error(`zen systemOne ${response.status}: ${(await response.text()).slice(0, 160)}`)

    const body: unknown = await response.json()
    const parsed = isZenBody(body) ? parseZenResponse(body, request.questions) : undefined

    if (parsed === undefined) throw new Error("zen systemOne returned an unrecognized body")

    return parsed
  },
})

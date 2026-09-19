// Jev adapter. The TypeSafe implementation runs in a bundled Effect rc.116
// runtime, while this public seam stays Promise, AbortSignal, and plain data.

import type { CommandInput, Judged } from "./decision.ts"
import { contextQuestions, riskQuestions } from "./questions.ts"
import { createTypeSafeRuntime } from "./typesafe-runtime.ts"

/**
 * Model version is pinned on purpose: a threshold is a fact about one model
 * version. Bump deliberately, re-evaluating thresholds.
 */
export const DEFAULT_MODEL = "jev-1.13.0"

export interface JevJudge {
  /** signal: cooperative cancellation, honored by the adapter's transport. */
  judge(input: CommandInput, signal?: AbortSignal): Promise<Judged>
  /** Release provider runtime resources when the owning harness unloads. */
  readonly dispose?: () => Promise<void>
}

const questions = { risk: riskQuestions, context: contextQuestions }

/** Verify the pinned model with one minimal System One decision. */
export const modelAvailable = async (
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  const runtime = createTypeSafeRuntime(apiKey, model, questions)

  try {
    return await runtime.modelAvailable(signal)
  } finally {
    await runtime.dispose()
  }
}

export const createJudge = (apiKey: string, model: string = DEFAULT_MODEL): JevJudge => {
  const runtime = createTypeSafeRuntime(apiKey, model, questions)

  return {
    judge: (input, signal) => runtime.judge(input, signal),
    dispose: runtime.dispose,
  }
}

// Development points at the private workspace source. The package build
// overwrites this module with a self-contained rc.116 bundle.

import { createTypeSafeRuntime as createWorkspaceRuntime } from "@jevvy/typesafe-runtime"
import type { CommandInput, Judged } from "./decision.ts"
import type { NoulQuestion } from "./questions.ts"

interface QuestionSet {
  readonly risk: {
    readonly destructive: NoulQuestion
    readonly sensitive: NoulQuestion
    readonly executes: NoulQuestion
    readonly network: NoulQuestion
    readonly obfuscated: NoulQuestion
  }
  readonly context: {
    readonly authorized: NoulQuestion
    readonly off_task: NoulQuestion
  }
}

interface TypeSafeRuntime {
  readonly judge: (input: CommandInput, signal?: AbortSignal) => Promise<Judged>
  readonly modelAvailable: (signal?: AbortSignal) => Promise<boolean>
  readonly dispose: () => Promise<void>
}

export const createTypeSafeRuntime: (
  apiKey: string,
  model: string,
  questions: QuestionSet,
  transport?: typeof globalThis.fetch,
) => TypeSafeRuntime = createWorkspaceRuntime

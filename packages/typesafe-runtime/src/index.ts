// This package owns the rc.116 Effect runtime used by @effect/ai-typesafe.
// Its exported surface is deliberately plain so no Effect value, service tag,
// layer, or runtime can reach the OpenCode-facing rc.112 package.

import { TypeSafeClient, TypeSafeSchema } from "@effect/ai-typesafe"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import type * as Schema from "effect/Schema"
import { FetchHttpClient } from "effect/unstable/http"

export interface CommandInput {
  readonly command: string
  readonly cwd?: string
  readonly task?: string
}

export interface Judged {
  readonly risk: {
    readonly destructive: number
    readonly sensitive: number
    readonly executes: number
    readonly network: number
    readonly obfuscated: number
  }
  readonly context?: {
    readonly authorized: number
    readonly off_task: number
  }
  readonly model: string
}

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: {
    readonly false: string
    readonly true: string
  }
}

export interface QuestionSet {
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

export interface TypeSafeRuntime {
  readonly judge: (input: CommandInput, signal?: AbortSignal) => Promise<Judged>
  readonly modelAvailable: (signal?: AbortSignal) => Promise<boolean>
  readonly dispose: () => Promise<void>
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")

type Answers = typeof TypeSafeSchema.SystemOneResponse.Type["answers"]

const noul = (answers: Answers, key: string): number => {
  const answer = answers[key]

  if (answer?.type !== "noul") throw new Error(`TypeSafe returned no noul answer for ${key}`)

  return answer.noul
}

const stateFor = (input: CommandInput, useContext: boolean): Schema.Json => {
  if (useContext && input.task !== undefined) {
    return input.cwd === undefined
      ? { command: input.command, task: input.task.slice(0, 1200) }
      : { command: input.command, cwd: input.cwd, task: input.task.slice(0, 1200) }
  }

  return input.cwd === undefined
    ? { command: input.command }
    : { command: input.command, cwd: input.cwd }
}

export const createTypeSafeRuntime = (
  apiKey: string,
  model: string,
  questions: QuestionSet,
  transport: typeof globalThis.fetch = globalThis.fetch,
): TypeSafeRuntime => {
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport)),
  )

  const clientLayer = TypeSafeClient.layer({ apiKey: Redacted.make(apiKey) }).pipe(
    Layer.provide(fetchLayer),
  )

  const runtime = ManagedRuntime.make(clientLayer)

  const run = async <A, E>(effect: Effect.Effect<A, E, TypeSafeClient.TypeSafeClient>, signal?: AbortSignal): Promise<A> => {
    try {
      return await runtime.runPromise(effect, { signal })
    } catch (error) {
      if (signal?.aborted === true) throw abortReason(signal)

      throw error
    }
  }

  return {
    async judge(input, signal) {
      const useContext = input.task !== undefined && input.task.length > 0

      const state = stateFor(input, useContext)

      const requestedQuestions = useContext
        ? { ...questions.risk, ...questions.context }
        : { ...questions.risk }

      const response = await run(
        TypeSafeClient.TypeSafeClient.use((client) => client.systemOne({ model, state, questions: requestedQuestions })),
        signal,
      )

      return {
        risk: {
          destructive: noul(response.answers, "destructive"),
          sensitive: noul(response.answers, "sensitive"),
          executes: noul(response.answers, "executes"),
          network: noul(response.answers, "network"),
          obfuscated: noul(response.answers, "obfuscated"),
        },
        context: useContext
          ? {
              authorized: noul(response.answers, "authorized"),
              off_task: noul(response.answers, "off_task"),
            }
          : undefined,
        model,
      }
    },
    async modelAvailable(signal) {
      await run(
        TypeSafeClient.TypeSafeClient.use((client) =>
          client.systemOne({
            model,
            state: { probe: "availability check" },
            questions: {
              ready: { type: "noul", instructions: "The word `ready` appears in `probe`" },
            },
          })),
        signal,
      )

      return true
    },
    dispose: () => runtime.dispose(),
  }
}

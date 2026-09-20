// This package owns the rc.116 Effect runtime used by @effect/ai-typesafe.
// Its exported surface is deliberately plain so no Effect value, service tag,
// layer, or runtime can reach callers.

import { TypeSafeClient } from "@effect/ai-typesafe"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import type * as Schema from "effect/Schema"
import { FetchHttpClient } from "effect/unstable/http"

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: {
    readonly false: string
    readonly true: string
  }
}

export interface JevRequest {
  readonly state: Schema.Json
  readonly questions: Readonly<Record<string, NoulQuestion>>
}

export interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface JevResult {
  readonly model: string
  readonly answers: Readonly<Record<string, NoulAnswer>>
}

export interface TypeSafeRuntime {
  readonly evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResult>
  readonly dispose: () => Promise<void>
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")

type SystemOneResult = Effect.Success<ReturnType<TypeSafeClient.Service["systemOne"]>>

type Answers = SystemOneResult["answers"]

const answersFor = (answers: Answers, questions: Readonly<Record<string, NoulQuestion>>) => {
  const result: Record<string, NoulAnswer> = {}

  for (const key of Object.keys(questions)) {
    const answer = answers[key]

    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error(`TypeSafe returned no valid noul answer for ${key}`)
    }

    result[key] = { type: "noul", noul: answer.noul }
  }

  return result
}

export const createTypeSafeRuntime = (
  apiKey: string,
  model: string,
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
    async evaluate(request, signal) {
      if (Object.keys(request.questions).length === 0) throw new Error("System One requires at least one question")

      const response = await run(
        TypeSafeClient.TypeSafeClient.use((client) => client.systemOne({
          model,
          state: request.state,
          questions: request.questions,
        })),
        signal,
      )

      return { model: response.model, answers: answersFor(response.answers, request.questions) }
    },
    dispose: () => runtime.dispose(),
  }
}

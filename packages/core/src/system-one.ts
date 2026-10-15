import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { JevProviderError } from "./provider-error.ts"
import type { JevProvider } from "./provider-error.ts"
import { executeProviderRequest } from "./provider-http.ts"
import { JevRequest, JevResult } from "./types.ts"
import type { JevClient, NoulQuestion } from "./types.ts"

const SystemOneRequest = Schema.Struct({
  model: Schema.NonEmptyString,
  ...JevRequest.fields,
})

const SystemOneResponse = Schema.Struct({
  model: JevResult.fields.model,
  answers: JevResult.fields.answers,
})

const RoutedSystemOneResponse = Schema.Struct({
  ...SystemOneResponse.fields,
  routing: Schema.Struct({ model: Schema.NonEmptyString }),
})

const validateRequestedAnswers = (
  provider: JevProvider,
  result: JevResult,
  questions: Readonly<Record<string, NoulQuestion>>,
): Effect.Effect<JevResult, JevProviderError> => {
  for (const key of Object.keys(questions)) {
    if (result.answers[key] === undefined) {
      return new JevProviderError({
        provider,
        kind: "invalid-response",
        message: `System One returned no valid noul answer for ${key}`,
      })
    }
  }

  return Effect.succeed(result)
}

export interface SystemOneClientOptions {
  readonly provider: JevProvider
  readonly url: string
  readonly model: string
  readonly headers: Readonly<Record<string, string>>
  readonly modelIdentity?: "model" | "routing.model"
}

export interface SystemOneBodyInput {
  readonly model?: unknown
  readonly answers?: unknown
}

export const createSystemOneClient = (options: SystemOneClientOptions): JevClient => ({
  evaluate: Effect.fn(`${options.provider}.evaluate`)(function*(request: JevRequest) {
    if (Object.keys(request.questions).length === 0) {
      return yield* new JevProviderError({
        provider: options.provider,
        kind: "invalid-request",
        message: "System One requires at least one question",
      })
    }

    const httpRequest = yield* HttpClientRequest.post(options.url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeaders(options.headers),
      HttpClientRequest.schemaBodyJson(SystemOneRequest)({
        model: options.model,
        state: request.state,
        questions: request.questions,
      }),
      Effect.mapError((cause) => new JevProviderError({
        provider: options.provider,
        kind: "invalid-request",
        message: `${options.provider} System One request could not be encoded`,
        cause,
      })),
    )

    const response = yield* executeProviderRequest(options.provider, httpRequest)

    const decoded = yield* (options.modelIdentity === "routing.model"
      ? HttpClientResponse.schemaBodyJson(RoutedSystemOneResponse)(response).pipe(
        Effect.map(({ model, answers, routing }) => ({
          model: routing.model,
          answers,
          reportedModel: model,
        })),
      )
      : HttpClientResponse.schemaBodyJson(SystemOneResponse)(response)).pipe(
      Effect.mapError((cause) => new JevProviderError({
        provider: options.provider,
        kind: "invalid-response",
        message: `${options.provider} System One returned an unrecognized body`,
        status: response.status,
        cause,
      })),
    )

    if (options.modelIdentity === "routing.model" && decoded.model !== options.model) {
      return yield* new JevProviderError({
        provider: options.provider,
        kind: "invalid-response",
        message: `${options.provider} System One served ${decoded.model} instead of ${options.model}`,
        status: response.status,
      })
    }

    return yield* validateRequestedAnswers(options.provider, decoded, request.questions)
  }),
})

export const parseSystemOneResponse = (
  raw: SystemOneBodyInput,
  questions?: Readonly<Record<string, NoulQuestion>>,
): JevResult | undefined => {
  const result = Option.getOrUndefined(Schema.decodeUnknownOption(JevResult)(raw))

  if (result === undefined) return undefined

  if (questions !== undefined) {
    for (const key of Object.keys(questions)) {
      if (result.answers[key] === undefined) return undefined
    }
  }

  return result
}

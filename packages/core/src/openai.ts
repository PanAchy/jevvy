import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Predicate from "effect/Predicate"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { executeProviderRequest } from "./provider-http.ts"
import { JevProviderError } from "./provider-error.ts"
import { JevResult, Json, NoulAnswer } from "./types.ts"
import type { JevClient, JevRequest, NoulQuestion } from "./types.ts"

export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions"

export const DEFAULT_OPENAI_MODEL = "gpt-6-luna"

const PredicateQuestion = Schema.Struct({
  type: Schema.Literal("predicate"),
  name: Schema.String,
  instructions: Schema.String,
})

const DecisionsRequest = Schema.Struct({
  model: Schema.NonEmptyString,
  input: Schema.String,
  questions: Schema.Array(PredicateQuestion).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})

const DecisionsResponse = Schema.Struct({
  model: JevResult.fields.model,
  answers: Schema.Array(Schema.Struct({
    type: Schema.Literal("predicate"),
    name: Schema.String,
    probability: NoulAnswer.fields.noul,
  })),
})

const predicateInstructions = (question: NoulQuestion): string => question.criteria === undefined
  ? question.instructions
  : `${question.instructions}\n\nFalse (probability 0): ${question.criteria.false}\nTrue (probability 1): ${question.criteria.true}`

export const createOpenAIClient = (
  apiKey: string,
  model: string = DEFAULT_OPENAI_MODEL,
): JevClient => ({
  evaluate: Effect.fn("openai.evaluate")(function*(request: JevRequest) {
    const questions = Object.entries(request.questions).map(([name, question]) => ({
      type: "predicate" as const,
      name,
      instructions: predicateInstructions(question),
    }))

    const input = yield* (Predicate.isString(request.state)
      ? Effect.succeed(request.state)
      : Schema.encodeEffect(Schema.fromJsonString(Json))(request.state)).pipe(
      Effect.mapError((cause) => new JevProviderError({
        provider: "openai",
        kind: "invalid-request",
        message: "OpenAI Decisions input could not be encoded",
        cause,
      })),
    )

    const httpRequest = yield* HttpClientRequest.post(OPENAI_DECISIONS_URL).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.schemaBodyJson(DecisionsRequest)({ model, input, questions }),
      Effect.mapError((cause) => new JevProviderError({
        provider: "openai",
        kind: "invalid-request",
        message: "OpenAI Decisions requires 1 to 200 valid predicate questions",
        cause,
      })),
    )

    const response = yield* executeProviderRequest("openai", httpRequest)

    const decoded = yield* HttpClientResponse.schemaBodyJson(DecisionsResponse)(response).pipe(
      Effect.mapError((cause) => new JevProviderError({
        provider: "openai",
        kind: "invalid-response",
        message: "OpenAI Decisions returned an unrecognized body or refused a question",
        status: response.status,
        cause,
      })),
    )

    if (decoded.answers.length !== questions.length ||
      decoded.answers.some((answer, index) => answer.name !== questions[index]?.name)) {
      return yield* new JevProviderError({
        provider: "openai",
        kind: "invalid-response",
        message: "OpenAI Decisions did not return every named answer in question order",
        status: response.status,
      })
    }

    return {
      model: decoded.model,
      answers: Object.fromEntries(decoded.answers.map(({ name, probability }) => [
        name,
        { type: "noul" as const, noul: probability },
      ])),
    }
  }),
})

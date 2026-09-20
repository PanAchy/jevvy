import { Clock, Effect, Option, Schema } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { JevProviderError } from "./provider-error.ts"
import type { JevProvider, JevProviderErrorKind } from "./provider-error.ts"
import type { JevClient, JevRequest, JevResult, NoulQuestion } from "./types.ts"

const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
})

const NoulQuestion = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Schema.String,
  criteria: Schema.optional(Schema.Struct({
    false: Schema.String,
    true: Schema.String,
  })),
})

const SystemOneRequest = Schema.Struct({
  model: Schema.NonEmptyString,
  state: Schema.Json,
  questions: Schema.Record(Schema.String, NoulQuestion),
})

const SystemOneResponse = Schema.Struct({
  model: Schema.NonEmptyString,
  answers: Schema.Record(Schema.String, NoulAnswer),
})

const ProviderErrorDetails = Schema.Struct({
  message: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
})

const ProviderErrorBody = Schema.Union([
  Schema.Struct({ error: ProviderErrorDetails }),
  ProviderErrorDetails,
])

const decodeProviderErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderErrorBody))

interface ErrorDetails {
  readonly code?: string
  readonly message?: string
}

const errorDetails = (text: string): ErrorDetails => {
  const decoded = Option.getOrUndefined(decodeProviderErrorBody(text))

  if (decoded === undefined) return {}

  const details = "error" in decoded ? decoded.error : decoded

  return {
    code: details.code === undefined ? details.type : String(details.code),
    message: details.message,
  }
}

const creditCodes = new Set([
  "CreditsError",
  "billing_required",
  "credit_balance_exhausted",
  "insufficient_credits",
  "insufficient_quota",
])

const quotaCodes = new Set([
  "BlackUsageLimitError",
  "FreeUsageLimitError",
  "GoUsageLimitError",
  "MonthlyLimitError",
  "UserLimitError",
])

const classifyError = (status: number, code: string | undefined): JevProviderErrorKind => {
  if (code !== undefined && creditCodes.has(code)) return "credits-exhausted"

  if (code !== undefined && quotaCodes.has(code)) return "quota-exhausted"

  if (code === "AuthError") return "authentication"

  if (code === "RateLimitError" || code === "rate_limit_error") return "rate-limited"

  if (status === 401 || status === 403) return "authentication"

  if (status === 402) return "credits-exhausted"

  if (status === 429) return "rate-limited"

  if (status === 400 || status === 404 || status === 422) return "invalid-request"

  return "unavailable"
}

const retryAfter = Effect.fnUntraced(function*(response: HttpClientResponse.HttpClientResponse) {
  const milliseconds = Option.getOrUndefined(Headers.get(response.headers, "retry-after-ms"))

  if (milliseconds !== undefined && milliseconds.trim().length > 0) {
    const parsed = Number(milliseconds)

    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  const raw = Option.getOrUndefined(Headers.get(response.headers, "retry-after"))

  if (raw === undefined || raw.trim().length === 0) return undefined

  const seconds = Number(raw)

  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000

  const date = Date.parse(raw)

  if (Number.isNaN(date)) return undefined

  const now = yield* Clock.currentTimeMillis

  return Math.max(0, date - now)
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

    const response = yield* HttpClient.execute(httpRequest).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((cause) => new JevProviderError({
        provider: options.provider,
        kind: "unavailable",
        message: `${options.provider} System One is unavailable`,
        cause,
      })),
    )

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((body) => body.slice(0, 2_000)),
      )

      const details = errorDetails(text)

      return yield* new JevProviderError({
        provider: options.provider,
        kind: classifyError(response.status, details.code),
        message: details.message ?? `${options.provider} System One returned HTTP ${response.status}`,
        status: response.status,
        code: details.code,
        retryAfterMs: yield* retryAfter(response),
      })
    }

    const result = yield* HttpClientResponse.schemaBodyJson(SystemOneResponse)(response).pipe(
      Effect.mapError((cause) => new JevProviderError({
        provider: options.provider,
        kind: "invalid-response",
        message: `${options.provider} System One returned an unrecognized body`,
        status: response.status,
        cause,
      })),
    )

    return yield* validateRequestedAnswers(options.provider, result, request.questions)
  }),
})

export const parseSystemOneResponse = (
  raw: SystemOneBodyInput,
  questions?: Readonly<Record<string, NoulQuestion>>,
): JevResult | undefined => {
  const result = Option.getOrUndefined(Schema.decodeUnknownOption(SystemOneResponse)(raw))

  if (result === undefined) return undefined

  if (questions !== undefined) {
    for (const key of Object.keys(questions)) {
      if (result.answers[key] === undefined) return undefined
    }
  }

  return result
}

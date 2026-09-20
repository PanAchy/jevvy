import { Clock, Effect, Option, Schema } from "effect"
import { JevProviderError } from "./provider-error.ts"
import type { JevProvider, JevProviderErrorKind } from "./provider-error.ts"
import type { JevClient, JevRequest, JevResult, NoulQuestion } from "./types.ts"

const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
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

const decodeSystemOneResponse = Schema.decodeUnknownEffect(SystemOneResponse)

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

const retryAfter = Effect.fnUntraced(function*(response: Response) {
  const milliseconds = response.headers.get("retry-after-ms")

  if (milliseconds !== null && milliseconds.trim().length > 0) {
    const parsed = Number(milliseconds)

    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  const raw = response.headers.get("retry-after")

  if (raw === null || raw.trim().length === 0) return undefined

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
  readonly transport: typeof globalThis.fetch
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

    const response = yield* Effect.tryPromise({
      try: (signal) => options.transport(options.url, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, state: request.state, questions: request.questions }),
        signal,
      }),
      catch: (cause) => new JevProviderError({
        provider: options.provider,
        kind: "unavailable",
        message: `${options.provider} System One is unavailable`,
        cause,
      }),
    })

    if (!response.ok) {
      const text = yield* Effect.tryPromise(() => response.text()).pipe(
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

    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new JevProviderError({
        provider: options.provider,
        kind: "invalid-response",
        message: `${options.provider} System One returned invalid JSON`,
        status: response.status,
        cause,
      }),
    })

    const result = yield* decodeSystemOneResponse(body).pipe(
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

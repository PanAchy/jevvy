import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import { JevProviderError } from "./provider-error.ts"
import type { JevProvider, JevProviderErrorKind } from "./provider-error.ts"

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
  "customer_verification_required",
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

export const executeProviderRequest = Effect.fn("ProviderHttp.execute")(function*(
  provider: JevProvider,
  request: HttpClientRequest.HttpClientRequest,
) {
  const response = yield* HttpClient.execute(request).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) => new JevProviderError({
      provider,
      kind: "unavailable",
      message: `${provider} is unavailable`,
      cause,
    })),
  )

  if (response.status >= 200 && response.status < 300) return response

  const text = yield* response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((body) => body.slice(0, 2_000)),
  )

  const details = errorDetails(text)

  return yield* new JevProviderError({
    provider,
    kind: classifyError(response.status, details.code),
    message: details.message ?? `${provider} returned HTTP ${response.status}`,
    status: response.status,
    code: details.code,
    retryAfterMs: yield* retryAfter(response),
  })
})

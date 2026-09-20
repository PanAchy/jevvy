import { Schema } from "effect"

export const JevProvider = Schema.Literals(["zen", "typesafe", "openrouter", "vercel", "custom"])

export type JevProvider = typeof JevProvider.Type

export const JevProviderErrorKind = Schema.Literals([
  "authentication",
  "credits-exhausted",
  "quota-exhausted",
  "rate-limited",
  "invalid-request",
  "invalid-response",
  "unavailable",
])

export type JevProviderErrorKind = typeof JevProviderErrorKind.Type

const ProviderFailureFields = {
  provider: JevProvider,
  kind: JevProviderErrorKind,
  message: Schema.String,
  status: Schema.optional(Schema.Int),
  code: Schema.optional(Schema.String),
  retryAfterMs: Schema.optional(Schema.Number),
}

export const JevProviderFailure = Schema.Struct(ProviderFailureFields)

export type JevProviderFailure = typeof JevProviderFailure.Type

export class JevProviderError extends Schema.TaggedError<JevProviderError>()("JevProviderError", {
  ...ProviderFailureFields,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const isJevProviderError = Schema.is(JevProviderError)

export const providerFailureOf = (error: JevProviderError): JevProviderFailure => ({
  provider: error.provider,
  kind: error.kind,
  message: error.message,
  status: error.status,
  code: error.code,
  retryAfterMs: error.retryAfterMs,
})

import { Schema } from "effect"
import type { Effect } from "effect"
import type { JevProviderError } from "./provider-error.ts"

export type JsonPrimitive = null | boolean | number | string

export const Json = Schema.Json

export type Json = Schema.Schema.Type<typeof Json>

export const NoulQuestion = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Schema.String,
  criteria: Schema.optionalKey(Schema.Struct({
    false: Schema.String,
    true: Schema.String,
  })),
})

export interface NoulQuestion extends Schema.Schema.Type<typeof NoulQuestion> {}

export const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
})

export interface NoulAnswer extends Schema.Schema.Type<typeof NoulAnswer> {}

export const JevRequest = Schema.Struct({
  state: Json,
  questions: Schema.Record(Schema.String, NoulQuestion),
})

export interface JevRequest extends Schema.Schema.Type<typeof JevRequest> {}

export const JevResult = Schema.Struct({
  model: Schema.NonEmptyString,
  answers: Schema.Record(Schema.String, NoulAnswer),
})

export interface JevResult extends Schema.Schema.Type<typeof JevResult> {}

export interface JevClient {
  readonly evaluate: (request: JevRequest) => Effect.Effect<JevResult, JevProviderError>
}

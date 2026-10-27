import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { JevProviderError } from "./provider-error.ts"
import { executeProviderRequest } from "./provider-http.ts"
import { SystemOneResponse, validateRequestedAnswers } from "./system-one.ts"
import { JevRequest, NoulQuestion } from "./types.ts"
import type { JevClient } from "./types.ts"

export const CloudflareModel = Schema.Literals(["clef", "clef-flash"])

export type CloudflareModel = typeof CloudflareModel.Type

export const CloudflareAccountID = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32}$/))

export const DEFAULT_CLOUDFLARE_MODEL = "clef"

export const CLOUDFLARE_MAX_INPUT_BYTES = 8_192

const CloudflareRequest = Schema.Struct({
  model: CloudflareModel,
  state: JevRequest.fields.state,
  questions: Schema.Record(
    Schema.String,
    NoulQuestion,
  ).check(
    Schema.isPropertyNames(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,100}$/))),
    Schema.isMinProperties(1),
    Schema.isMaxProperties(64),
  ),
})

const CloudflareResponse = Schema.Struct({
  success: Schema.Literal(true),
  errors: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0)),
  result: SystemOneResponse,
})

export interface CloudflareClientOptions {
  readonly accountId: string
  readonly apiKey: string
  readonly model?: CloudflareModel
}

export const createCloudflareClient = (options: CloudflareClientOptions): JevClient => ({
  evaluate: Effect.fn("cloudflare.evaluate")(function*(request: JevRequest) {
    const model = options.model ?? DEFAULT_CLOUDFLARE_MODEL

    const accountId = yield* Schema.decodeEffect(CloudflareAccountID)(options.accountId).pipe(
      Effect.mapError(() => new JevProviderError({ provider: "cloudflare", kind: "invalid-request", message: "Cloudflare requires a 32-character hexadecimal account ID" })),
    )

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(CloudflareRequest))({ model, state: request.state, questions: request.questions }).pipe(
      Effect.mapError((cause) => new JevProviderError({ provider: "cloudflare", kind: "invalid-request", message: "Cloudflare Clef request could not be encoded", cause })),
    )

    if (new TextEncoder().encode(body).byteLength > CLOUDFLARE_MAX_INPUT_BYTES) {
      return yield* new JevProviderError({
        provider: "cloudflare", kind: "invalid-request",
        message: `Cloudflare Clef requests must fit within ${CLOUDFLARE_MAX_INPUT_BYTES} UTF-8 bytes to avoid provider-side truncation`,
      })
    }

    const response = yield* executeProviderRequest("cloudflare", HttpClientRequest.post(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`,
    ).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(options.apiKey),
      HttpClientRequest.bodyText(body, "application/json"),
    ))

    const decoded = yield* HttpClientResponse.schemaBodyJson(CloudflareResponse)(response).pipe(
      Effect.mapError((cause) => new JevProviderError({ provider: "cloudflare", kind: "invalid-response", message: "Cloudflare Clef returned an unrecognized or unsuccessful body", status: response.status, cause })),
    )

    if (decoded.result.model !== model) {
      return yield* new JevProviderError({ provider: "cloudflare", kind: "invalid-response", message: "Cloudflare Clef returned an unexpected model", status: response.status })
    }

    return yield* validateRequestedAnswers("cloudflare", decoded.result, request.questions)
  }),
})

import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createTypeSafeClient } from "../src/typesafe.ts"

afterEach(() => vi.restoreAllMocks())

describe("TypeSafe client", () => {
  it.effect("evaluates through the shared Effect runtime", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "jev-served",
      answers: {
        harmless: { type: "noul", noul: 0.99 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    }))

    const client = createTypeSafeClient("test-key", "jev-test")

    const result = yield* client.evaluate({
      state: { command: "pwd" },
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    expect(result).toEqual({
      model: "jev-served",
      answers: { harmless: { type: "noul", noul: 0.99 } },
    })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype)

  }))

  it.effect("rejects missing requested answers", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "jev-test",
      answers: {},
    }))

    const client = createTypeSafeClient("test-key", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "invalid-response",
    })
  }))

  it.effect("rejects request state that cannot be encoded as JSON", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>()
    const client = createTypeSafeClient("test-key", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: Number.NaN,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "invalid-request",
    })
    expect(transport).not.toHaveBeenCalled()
  }))

  it.effect("maps HTTP transport failures to provider unavailability", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))
    const client = createTypeSafeClient("test-key", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "unavailable",
    })
  }))

  it.effect("maps malformed success bodies to invalid responses", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }))

    const client = createTypeSafeClient("test-key", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "invalid-response",
      status: 200,
    })
  }))

  it.effect("preserves exhausted-credit responses", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      message: "Insufficient credits. Top up to continue.",
      type: "insufficient_quota",
    }, { status: 402 }))

    const client = createTypeSafeClient("empty", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "credits-exhausted",
      status: 402,
      code: "insufficient_quota",
    })
  }))

  it.effect("maps customer verification gates to exhausted credits", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: {
        message: "AI Gateway requires a valid credit card on file before free credits can be used.",
        type: "customer_verification_required",
      },
    }, { status: 403 }))

    const client = createTypeSafeClient("unverified", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "credits-exhausted",
      status: 403,
      code: "customer_verification_required",
    })
  }))

  it.effect("preserves TypeSafe rate limits as transient failures", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      message: "Rate limit exceeded",
      type: "rate_limit_error",
    }, { status: 429, headers: { "retry-after": "3" } }))

    const client = createTypeSafeClient("busy", "jev-test")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "rate-limited",
      status: 429,
      code: "rate_limit_error",
      retryAfterMs: 3_000,
    })
  }))
})

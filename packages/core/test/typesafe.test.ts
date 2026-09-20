import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
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

    const client = createTypeSafeClient("test-key", "jev-test", transport)

    const result = yield* client.evaluate({
      state: { command: "pwd" },
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    })

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

    const client = createTypeSafeClient("test-key", "jev-test", transport)

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "invalid-response",
    })
  }))

  it.effect("preserves exhausted-credit responses", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      message: "Insufficient credits. Top up to continue.",
      type: "insufficient_quota",
    }, { status: 402 }))

    const client = createTypeSafeClient("empty", "jev-test", transport)

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "typesafe",
      kind: "credits-exhausted",
      status: 402,
      code: "insufficient_quota",
    })
  }))

  it.effect("preserves TypeSafe rate limits as transient failures", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      message: "Rate limit exceeded",
      type: "rate_limit_error",
    }, { status: 429, headers: { "retry-after": "3" } }))

    const client = createTypeSafeClient("busy", "jev-test", transport)

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }))

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

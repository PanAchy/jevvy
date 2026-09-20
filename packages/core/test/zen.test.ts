import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { createZenClient, parseZenResponse, ZEN_SYSTEMONE_URL } from "../src/zen.ts"

afterEach(() => vi.restoreAllMocks())

describe("Zen client", () => {
  it.effect("sends arbitrary JSON state and questions", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "jev-test",
      answers: { routine: { type: "noul", noul: 0.9 } },
    }))

    const client = createZenClient("secret", "jev-test", transport)

    const result = yield* client.evaluate({
      state: { operation: "index", items: [1, 2] },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    })

    expect(result.answers.routine?.noul).toBe(0.9)
    expect(transport).toHaveBeenCalledOnce()

    const [url, init] = transport.mock.calls[0] ?? []
    expect(url).toBe(ZEN_SYSTEMONE_URL)
    expect(init?.headers).toEqual({ "x-api-key": "secret", "content-type": "application/json" })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "jev-test",
      state: { operation: "index", items: [1, 2] },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    })
  }))

  it("rejects missing, malformed, and out-of-range answers", () => {
    const questions = { routine: { type: "noul" as const, instructions: "Routine?" } }

    expect(parseZenResponse({ model: "m", answers: {} }, questions)).toBeUndefined()
    expect(parseZenResponse({ model: "m", answers: { routine: { type: "choice", choice: "yes" } } }, questions)).toBeUndefined()
    expect(parseZenResponse({ model: "m", answers: { routine: { type: "noul", noul: 1.1 } } }, questions)).toBeUndefined()
    expect(parseZenResponse({ answers: { routine: { type: "noul", noul: 0.5 } } }, questions)).toBeUndefined()
  })

  it.effect("surfaces non-success responses", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      type: "error",
      error: { type: "AuthError", message: "Invalid API key" },
    }, { status: 401 }))

    const client = createZenClient("bad", "jev-test", transport)

    const error = yield* Effect.flip(client.evaluate({
      state: "hello",
      questions: { routine: { type: "noul", instructions: "Routine?" } },
    }))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "zen",
      kind: "authentication",
      status: 401,
      code: "AuthError",
    })
  }))

  it.effect("distinguishes exhausted Zen credits from authentication failures sharing status 401", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      type: "error",
      error: { type: "CreditsError", message: "Insufficient balance" },
    }, { status: 401 }))

    const client = createZenClient("empty", "jev-test", transport)

    const error = yield* Effect.flip(client.evaluate({
      state: "hello",
      questions: { routine: { type: "noul", instructions: "Routine?" } },
    }))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "zen",
      kind: "credits-exhausted",
      status: 401,
      code: "CreditsError",
    })
  }))

  it.effect("preserves temporary Zen limit evidence", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      type: "error",
      error: { type: "RateLimitError", message: "Try again later" },
    }, { status: 429, headers: { "retry-after": "12" } }))

    const client = createZenClient("busy", "jev-test", transport)

    const error = yield* Effect.flip(client.evaluate({
      state: "hello",
      questions: { routine: { type: "noul", instructions: "Routine?" } },
    }))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "zen",
      kind: "rate-limited",
      status: 429,
      code: "RateLimitError",
      retryAfterMs: 12_000,
    })
  }))
})

import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { createOpenAIClient, DEFAULT_OPENAI_MODEL, OPENAI_DECISIONS_URL } from "../src/openai.ts"
import type { JevRequest } from "../src/types.ts"

const request: JevRequest = {
  state: { command: "pwd && git status", directory: "/project", context: [1, true, null] },
  questions: {
    harmful: { type: "noul", instructions: "Could this cause harm?", criteria: { false: "Harmless", true: "Harmful" } },
    obscured: { type: "noul", instructions: "Is consequential behavior obscured?" },
  },
}

const answers = [
  { type: "predicate", name: "harmful", probability: 0.03 },
  { type: "predicate", name: "obscured", probability: 0.1 },
]

describe("OpenAI Decisions client", () => {
  it.effect("preserves complete JSON evidence and translates criteria without reversing probabilities", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "gpt-6-luna", answers }))

    const result = yield* createOpenAIClient("secret").evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    expect(result).toEqual({
      model: "gpt-6-luna",
      answers: { harmful: { type: "noul", noul: 0.03 }, obscured: { type: "noul", noul: 0.1 } },
    })
    expect(transport).toHaveBeenCalledOnce()

    const [url, init] = transport.mock.calls[0] ?? []

    expect(String(url)).toBe(OPENAI_DECISIONS_URL)

    const headers = new Headers(init?.headers)

    expect(headers.get("authorization")).toBe("Bearer secret")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
    expect(init?.body).toBeInstanceOf(Uint8Array)

    if (!(init?.body instanceof Uint8Array)) throw new Error("Expected JSON request bytes")

    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({
      model: DEFAULT_OPENAI_MODEL,
      input: JSON.stringify(request.state),
      questions: [
        { type: "predicate", name: "harmful", instructions: "Could this cause harm?\n\nFalse (probability 0): Harmless\nTrue (probability 1): Harmful" },
        { type: "predicate", name: "obscured", instructions: "Is consequential behavior obscured?" },
      ],
    })
  }))

  it.effect("uses text state unchanged and retains boundary probabilities", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "gpt-6-luna",
      answers: [{ type: "predicate", name: "risk", probability: 0 }, { type: "predicate", name: "certain", probability: 1 }],
    }))

    const result = yield* createOpenAIClient("secret").evaluate({
      state: "pwd && printf '%s' \"quoted text\"",
      questions: {
        risk: { type: "noul", instructions: "Risk?" },
        certain: { type: "noul", instructions: "Certain?" },
      },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    expect(result.answers.risk?.noul).toBe(0)
    expect(result.answers.certain?.noul).toBe(1)

    const body = transport.mock.calls[0]?.[1]?.body

    if (!(body instanceof Uint8Array)) throw new Error("Expected JSON request bytes")

    expect(JSON.parse(new TextDecoder().decode(body)).input).toBe("pwd && printf '%s' \"quoted text\"")
  }))

  it.effect.each([
    [],
    [answers[0]],
    [...answers, { type: "predicate", name: "extra", probability: 0 }],
    [answers[1], answers[0]],
    [answers[0], answers[0]],
    [{ type: "predicate", name: "other", probability: 0 }, answers[1]],
    [{ type: "predicate", name: null, probability: 0 }, answers[1]],
    [{ type: "refusal", name: "harmful" }, answers[1]],
    [{ type: "choice", name: "harmful", choice: false }, answers[1]],
    [{ type: "predicate", name: "harmful", probability: -0.1 }, answers[1]],
    [{ type: "predicate", name: "harmful", probability: 1.1 }, answers[1]],
    [{ type: "predicate", name: "harmful", probability: "0.03" }, answers[1]],
    [{ type: "predicate", name: "harmful", probability: null }, answers[1]],
  ].map((returned) => ({ returned })))("rejects incomplete, ambiguous, refused, or invalid answers: %j", ({ returned }) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "gpt-6-luna", answers: returned }))

    const error = yield* createOpenAIClient("secret").evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip,
    )

    expect(error).toMatchObject({ provider: "openai", kind: "invalid-response" })
  }))

  it.effect.each([
    { answers },
    { model: "", answers },
    { model: "gpt-6-luna", answers: {} },
  ])("rejects malformed response envelopes: %j", (body) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))

    const error = yield* createOpenAIClient("secret").evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip,
    )

    expect(error.kind).toBe("invalid-response")
  }))

  it.effect.each([0, 201])("rejects %s questions before contacting the provider", (count) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>()

    const error = yield* createOpenAIClient("secret").evaluate({
      state: "pwd",
      questions: Object.fromEntries(Array.from({ length: count }, (_, index) => [
        `q${index}`, { type: "noul" as const, instructions: "Risk?" },
      ])),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip)

    expect(error.kind).toBe("invalid-request")
    expect(transport).not.toHaveBeenCalled()
  }))

  it.effect.each([
    [401, "invalid_api_key", "authentication"],
    [429, "rate_limit_error", "rate-limited"],
    [429, "insufficient_quota", "credits-exhausted"],
    [400, "invalid_request_error", "invalid-request"],
    [503, "server_error", "unavailable"],
  ] as const)("preserves HTTP %s failure evidence", ([status, code, kind]) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: { code, message: "Provider detail" },
    }, { status, headers: { "retry-after": "3" } }))

    const error = yield* createOpenAIClient("secret").evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip,
    )

    expect(error).toMatchObject({ provider: "openai", kind, status, code, retryAfterMs: 3_000, message: "Provider detail" })
    expect(transport).toHaveBeenCalledOnce()
  }))

  it.effect("classifies network failures as unavailable", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))

    const error = yield* createOpenAIClient("secret").evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip,
    )

    expect(error).toMatchObject({ provider: "openai", kind: "unavailable" })
  }))

  it.effect("preserves interruption instead of returning provider unavailability", () => Effect.gen(function*() {
    const fiber = yield* createOpenAIClient("secret").evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, () => new Promise<Response>(() => {})), Effect.forkChild,
    )

    yield* Fiber.interrupt(fiber)

    const exit = yield* Fiber.await(fiber)

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }))
})

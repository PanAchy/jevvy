import { describe, expect, it, vi } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { CLOUDFLARE_MAX_INPUT_BYTES, createCloudflareClient } from "../src/cloudflare.ts"
import type { JevRequest } from "../src/types.ts"

const accountId = "0123456789abcdef0123456789abcdef"

const question = { type: "noul" as const, instructions: "Could this command cause harm?", criteria: { false: "Harmless", true: "Harmful" } }

const request: JevRequest = { state: { command: "pwd && git status > status.txt" }, questions: { harmful: question } }

const result = { model: "clef", answers: { harmful: { type: "noul", noul: 0.01 } } }

const client = createCloudflareClient({ accountId, apiKey: "fixture-token" })

describe("Cloudflare Clef", () => {
  it.effect.each(["clef", "clef-flash"] as const)("sends the complete System One input to the account-scoped %s route", (model) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, errors: [], result: { ...result, model } }))

    const selected = createCloudflareClient({ accountId, apiKey: "fixture-token", model })
    expect(yield* selected.evaluate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))).toEqual({ ...result, model })

    const [url, init] = transport.mock.calls[0] ?? []

    if (!(url instanceof URL)) throw new Error("Expected a URL request")

    expect(url.href).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token")
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
    expect(init?.method).toBe("POST")

    if (!(init?.body instanceof Uint8Array)) throw new Error("Expected encoded request bytes")

    expect(new TextDecoder().decode(init.body)).toBe(JSON.stringify({ model, state: request.state, questions: request.questions }))
  }))

  it.effect("accepts the byte limit exactly and refuses one additional byte without truncation", () => Effect.gen(function*() {
    const questions = { harmful: question }
    const overhead = new TextEncoder().encode(JSON.stringify({ model: "clef", state: "", questions })).byteLength
    const state = "a".repeat(CLOUDFLARE_MAX_INPUT_BYTES - overhead)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, errors: [], result }))

    expect(yield* client.evaluate({ state, questions }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))).toEqual(result)
    expect(yield* client.evaluate({ state: `${state}a`, questions }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip)).toMatchObject({ kind: "invalid-request" })
    expect(transport).toHaveBeenCalledOnce()
  }))

  it.effect.each([
    result,
    { success: false, errors: [], result },
    { success: true, errors: [{ code: 1000 }], result },
    { success: true, errors: [], result: { ...result, model: "clef-flash" } },
    { success: true, errors: [], result: { model: "clef", answers: {} } },
    { success: true, errors: [], result: { ...result, answers: { harmful: { type: "noul", noul: 1.01 } } } },
    { success: true, errors: [], result: { ...result, answers: { harmful: { type: "choice", choice: "safe" } } } },
  ])("rejects malformed, unsuccessful, incomplete, or mismatched responses: %j", (body) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
    const error = yield* client.evaluate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip)
    expect(error).toMatchObject({ provider: "cloudflare", kind: "invalid-response" })
  }))

  it.effect.each([
    [401, "authentication"], [403, "authentication"], [429, "rate-limited"], [500, "unavailable"],
  ] as const)("preserves HTTP %s failures", ([status, kind]) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: false, errors: [{ code: 10000, message: "Provider error" }] }, { status, headers: { "retry-after": "3" } }))
    const error = yield* client.evaluate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip)
    expect(error).toMatchObject({ provider: "cloudflare", kind, status, retryAfterMs: 3_000 })
    expect(error.message).not.toContain("fixture-token")
  }))

  it.effect.each([
    { state: "pwd", questions: {} },
    { state: "pwd", questions: { "bad id": question } },
    { state: "pwd", questions: { ["a".repeat(101)]: question } },
    { state: "pwd", questions: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, question])) },
    { state: "a".repeat(CLOUDFLARE_MAX_INPUT_BYTES), questions: { harmful: question } },
    { state: "界".repeat(3_000), questions: { harmful: question } },
    { state: "pwd", questions: { harmful: { ...question, instructions: "a".repeat(CLOUDFLARE_MAX_INPUT_BYTES) } } },
  ])("refuses oversized or unsupported requests before transport", (input) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>()
    const error = yield* client.evaluate(input).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip)
    expect(error).toMatchObject({ provider: "cloudflare", kind: "invalid-request" })
    expect(transport).not.toHaveBeenCalled()
  }))

  it.effect.each(["", "../other-account", "account?token=secret"])("refuses invalid account IDs before sending credentials: %s", (id) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>()
    const selected = createCloudflareClient({ accountId: id, apiKey: "fixture-token" })
    expect(yield* selected.evaluate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip)).toMatchObject({ kind: "invalid-request" })
    expect(transport).not.toHaveBeenCalled()
  }))

  it.effect("preserves interruption and aborts the outgoing request", () => Effect.gen(function*() {
    const started = yield* Deferred.make<AbortSignal>()

    const transport = vi.fn<typeof fetch>((_url, init) => {
      if (init?.signal === undefined || init.signal === null) throw new Error("Expected abort signal")
      Deferred.doneUnsafe(started, Effect.succeed(init.signal))

      return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
    })

    const fiber = yield* client.evaluate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport), Effect.forkChild)
    const signal = yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    expect(signal.aborted).toBe(true)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
  }))
})

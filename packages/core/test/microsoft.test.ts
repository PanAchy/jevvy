import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { createMicrosoftClient } from "../src/microsoft.ts"

const options = {
  endpoint: "https://example.services.ai.azure.com/providers/microsoft/v1/systemone",
  model: "my-decision-deployment",
  apiKey: "azure-secret",
}

const request = {
  state: { command: "pwd && git status", directory: "/project" },
  questions: {
    harmful: { type: "noul" as const, instructions: "Could this cause harm?", criteria: { false: "Harmless", true: "Harmful" } },
    sensitive: { type: "noul" as const, instructions: "Could this expose sensitive information?" },
  },
}

describe("Microsoft Decision System One client", () => {
  it.effect("uses Azure API-key auth and preserves deployment and underlying model identities", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "microsoft-decision-1",
      answers: { harmful: { type: "noul", noul: 0.02 }, sensitive: { type: "noul", noul: 0.08 } },
    }))

    const result = yield* createMicrosoftClient(options).evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    expect(result).toEqual({
      model: "microsoft-decision-1",
      answers: { harmful: { type: "noul", noul: 0.02 }, sensitive: { type: "noul", noul: 0.08 } },
    })

    const [url, init] = transport.mock.calls[0] ?? []

    expect(String(url)).toBe(options.endpoint)

    const headers = new Headers(init?.headers)

    expect(headers.get("api-key")).toBe("azure-secret")
    expect(headers.has("authorization")).toBe(false)
    expect(headers.get("content-type")).toBe("application/json")

    if (!(init?.body instanceof Uint8Array)) throw new Error("Expected JSON request bytes")

    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({ model: options.model, ...request })
  }))

  it.effect.each([
    {},
    { harmful: { type: "noul", noul: 0 } },
    { harmful: { type: "refusal" }, sensitive: { type: "noul", noul: 0 } },
    { harmful: { type: "noul", noul: 2 }, sensitive: { type: "noul", noul: 0 } },
    { harmful: { type: "noul", noul: "0" }, sensitive: { type: "noul", noul: 0 } },
  ])("rejects missing or invalid required Noul answers: %j", (answers) => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "microsoft-decision-1", answers }))

    const error = yield* createMicrosoftClient(options).evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip,
    )

    expect(error).toMatchObject({ provider: "microsoft", kind: "invalid-response" })
  }))

  it.effect("preserves Azure authentication errors", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: { code: "Unauthorized", message: "Invalid API key" },
    }, { status: 401 }))

    const error = yield* createMicrosoftClient(options).evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport), Effect.flip,
    )

    expect(error).toMatchObject({ provider: "microsoft", kind: "authentication", status: 401, code: "Unauthorized" })
  }))
})

import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createCustomSystemOneClient } from "../src/custom.ts"

afterEach(() => vi.restoreAllMocks())

describe("custom System One client", () => {
  it.effect("uses the configured endpoint, model, and optional Bearer credential", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "typesafe/jev-1.13-20260917",
      answers: { routine: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 275, output_tokens: 0 },
    }))

    const client = createCustomSystemOneClient({
      endpoint: "https://api.aimlapi.com/v1/decisions",
      model: "typesafe/jev",
      apiKey: "secret",
    })

    const result = yield* client.evaluate({
      state: { command: "pwd" },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    expect(result).toEqual({
      model: "typesafe/jev-1.13-20260917",
      answers: { routine: { type: "noul", noul: 0.99 } },
    })

    const [url, init] = transport.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)

    expect(String(url)).toBe("https://api.aimlapi.com/v1/decisions")
    expect(headers.get("authorization")).toBe("Bearer secret")

    const body = init?.body

    expect(body).toBeInstanceOf(Uint8Array)

    if (!(body instanceof Uint8Array)) return

    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      model: "typesafe/jev",
      state: { command: "pwd" },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    })
  }))

  it.effect("omits authorization for an unauthenticated local endpoint", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "laya-rl-agent",
      answers: { routine: { type: "noul", noul: 0.9 } },
    }))

    const client = createCustomSystemOneClient({
      endpoint: "http://127.0.0.1:8080/v1/decisions",
      model: "laya-typed-decisions",
    })

    yield* client.evaluate({
      state: "pwd",
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    const [, init] = transport.mock.calls[0] ?? []

    expect(new Headers(init?.headers).has("authorization")).toBe(false)
  }))
})

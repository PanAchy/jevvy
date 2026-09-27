import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createLayaClient, DEFAULT_LAYA_ENDPOINT } from "../src/laya.ts"

afterEach(() => vi.restoreAllMocks())

const request = {
  state: { action: "shell", resource: "pwd" },
  questions: { harmful: { type: "noul" as const, instructions: "Could this cause harm?" } },
}

const response = {
  model: "laya-rl-agent",
  answers: { harmful: { type: "noul", noul: 0.4, confidence: 0.6 } },
  routing: { model: "english", repo: "convaiinnovations/laya" },
  usage: { input_tokens: 100, output_tokens: 0 },
}

describe("Laya System One client", () => {
  it.effect("uses the local server and records the routed checkpoint identity", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))

    const result = yield* createLayaClient().evaluate(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    expect(result).toEqual({
      model: "english",
      reportedModel: "laya-rl-agent",
      answers: { harmful: { type: "noul", noul: 0.4 } },
    })

    const [url, init] = transport.mock.calls[0] ?? []

    expect(String(url)).toBe(DEFAULT_LAYA_ENDPOINT)
    expect(new Headers(init?.headers).has("authorization")).toBe(false)

    if (!(init?.body instanceof Uint8Array)) return

    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({
      model: "english",
      ...request,
    })
  }))

  it.effect("uses a configured endpoint, checkpoint, and optional Bearer key", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ...response,
      routing: { model: "multilingual" },
    }))

    const result = yield* createLayaClient({
      endpoint: "http://127.0.0.1:18871/v1/systemone",
      model: "multilingual",
      apiKey: "secret",
    }).evaluate(request).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    const [url, init] = transport.mock.calls[0] ?? []

    expect(result.model).toBe("multilingual")
    expect(String(url)).toBe("http://127.0.0.1:18871/v1/systemone")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret")
  }))

  it.effect.each([
    [{ ...response, routing: undefined }, "invalid-response"],
    [{ ...response, routing: { model: "multilingual" } }, "invalid-response"],
    [{ ...response, routing: { model: "" } }, "invalid-response"],
  ] as const)("abstains when the routed checkpoint cannot be verified", ([body, kind]) =>
    Effect.gen(function*() {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))

      const error = yield* createLayaClient().evaluate(request).pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport),
        Effect.flip,
      )

      expect(error).toMatchObject({ provider: "laya", kind })
    }))
})

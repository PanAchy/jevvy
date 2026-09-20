import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  createOpenRouterClient,
  OPENROUTER_SYSTEMONE_URL,
} from "../src/openrouter.ts"

afterEach(() => vi.restoreAllMocks())

describe("OpenRouter client", () => {
  it.effect("evaluates through the TypeSafe-compatible System One endpoint", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: "generation-id",
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers: { routine: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
    }))

    const client = createOpenRouterClient("secret", "typesafe/jev-test")

    const result = yield* client.evaluate({
      state: { command: "pwd" },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    expect(result).toEqual({
      model: "typesafe/jev-1.13-20260917",
      answers: { routine: { type: "noul", noul: 0.99 } },
    })
    expect(transport).toHaveBeenCalledOnce()

    const [url, init] = transport.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)

    expect(String(url)).toBe(OPENROUTER_SYSTEMONE_URL)
    expect(headers.get("authorization")).toBe("Bearer secret")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")

    const body = init?.body

    expect(body).toBeInstanceOf(Uint8Array)

    if (!(body instanceof Uint8Array)) return

    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      model: "typesafe/jev-test",
      state: { command: "pwd" },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    })
  }))
})

import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  createVercelClient,
  VERCEL_SYSTEMONE_URL,
} from "../src/vercel.ts"

afterEach(() => vi.restoreAllMocks())

describe("Vercel AI Gateway client", () => {
  it.effect("evaluates through the TypeSafe-compatible System One endpoint", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "typesafe-ai/jev",
      answers: { routine: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 275, output_tokens: 20 },
    }))

    const client = createVercelClient("secret", "typesafe-ai/jev-test")

    const result = yield* client.evaluate({
      state: { command: "pwd" },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    expect(result).toEqual({
      model: "typesafe-ai/jev",
      answers: { routine: { type: "noul", noul: 0.99 } },
    })
    expect(transport).toHaveBeenCalledOnce()

    const [url, init] = transport.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)

    expect(String(url)).toBe(VERCEL_SYSTEMONE_URL)
    expect(headers.get("authorization")).toBe("Bearer secret")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")

    const body = init?.body

    expect(body).toBeInstanceOf(Uint8Array)

    if (!(body instanceof Uint8Array)) return

    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      model: "typesafe-ai/jev-test",
      state: { command: "pwd" },
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    })
  }))

  it.effect("preserves Vercel verification failures", () => Effect.gen(function*() {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: {
        message: "AI Gateway requires a valid credit card on file before free credits can be used.",
        type: "customer_verification_required",
      },
    }, { status: 403 }))

    const client = createVercelClient("unverified")

    const error = yield* Effect.flip(client.evaluate({
      state: null,
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport)))

    expect(error).toMatchObject({
      name: "JevProviderError",
      provider: "vercel",
      kind: "credits-exhausted",
      status: 403,
      code: "customer_verification_required",
    })
  }))

  it.effect("aborts the provider request when evaluation is interrupted", () => Effect.gen(function*() {
    let markStarted: ((signal: AbortSignal) => void) | undefined

    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve
    })

    const transport = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const signal = init?.signal

      if (signal === undefined || signal === null) return Promise.reject(new Error("missing abort signal"))

      markStarted?.(signal)

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    })

    const client = createVercelClient("secret")

    const evaluation = client.evaluate({
      state: null,
      questions: { routine: { type: "noul", instructions: "Is this routine?" } },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    const fiber = yield* Effect.forkChild(evaluation)
    const signal = yield* Effect.promise(() => started)

    yield* Fiber.interrupt(fiber)

    expect(signal.aborted).toBe(true)
  }))
})

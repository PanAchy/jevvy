import { afterEach, describe, expect, it, vi } from "vitest"
import { createZenClient, parseZenResponse, ZEN_SYSTEMONE_URL } from "../src/zen.ts"

afterEach(() => vi.restoreAllMocks())

describe("Zen client", () => {
  it("sends arbitrary JSON state and questions", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "jev-test",
      answers: { routine: { type: "noul", noul: 0.9 } },
    }))

    const client = createZenClient("secret", "jev-test", transport)

    const result = await client.evaluate({
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
  })

  it("rejects missing, malformed, and out-of-range answers", () => {
    const questions = { routine: { type: "noul" as const, instructions: "Routine?" } }

    expect(parseZenResponse({ model: "m", answers: {} }, questions)).toBeUndefined()
    expect(parseZenResponse({ model: "m", answers: { routine: { type: "choice", choice: "yes" } } }, questions)).toBeUndefined()
    expect(parseZenResponse({ model: "m", answers: { routine: { type: "noul", noul: 1.1 } } }, questions)).toBeUndefined()
    expect(parseZenResponse({ answers: { routine: { type: "noul", noul: 0.5 } } }, questions)).toBeUndefined()
  })

  it("surfaces non-success responses", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 401 }))
    const client = createZenClient("bad", "jev-test", transport)

    await expect(client.evaluate({
      state: "hello",
      questions: { routine: { type: "noul", instructions: "Routine?" } },
    })).rejects.toThrow("zen systemOne 401")
  })
})

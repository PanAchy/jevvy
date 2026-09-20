import { afterEach, describe, expect, it, vi } from "vitest"
import { createTypeSafeClient } from "../src/typesafe.ts"

afterEach(() => vi.restoreAllMocks())

describe("TypeSafe client", () => {
  it("keeps Promise, AbortSignal, and plain data across the isolated runtime", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "jev-served",
      answers: {
        harmless: { type: "noul", noul: 0.99 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    }))

    const client = createTypeSafeClient("test-key", "jev-test", transport)

    const controller = new AbortController()

    const pending = client.evaluate({
      state: { command: "pwd" },
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    }, controller.signal)

    expect(pending).toBeInstanceOf(Promise)

    const result = await pending

    expect(result).toEqual({
      model: "jev-served",
      answers: { harmless: { type: "noul", noul: 0.99 } },
    })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype)

    await client.dispose?.()
  })

  it("rejects missing requested answers", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "jev-test",
      answers: {},
    }))

    const client = createTypeSafeClient("test-key", "jev-test", transport)

    await expect(client.evaluate({
      state: null,
      questions: { harmless: { type: "noul", instructions: "Is it harmless?" } },
    })).rejects.toThrow()

    await client.dispose?.()
  })
})

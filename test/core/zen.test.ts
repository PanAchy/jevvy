// Zen adapter parser tests, against the fixture shape captured from the live
// endpoint (2026-09-19 probe).

import { describe, expect, it } from "vitest"
import { parseZenResponse } from "../../src/core/zen.ts"
import type { ZenBodyInput } from "../../src/core/zen.ts"

const liveFixture = {
  model: "jev-1.13-free",
  answers: {
    routine: { type: "noul", noul: 0.96 },
  },
  usage: { input_tokens: 210, output_tokens: 18 },
}

const zenBodyOr = (body: ZenBodyInput | undefined): ReturnType<typeof parseZenResponse> =>
  body === undefined ? undefined : parseZenResponse(body)

const live = zenBodyOr(liveFixture)

describe("parseZenResponse", () => {
  it("accepts the live response shape", () => {
    expect(live?.model).toBe("jev-1.13-free")
    expect(live?.answers.routine?.noul).toBe(0.96)
  })

  it("rejects non-noul answers", () => {
    const bad: ZenBodyInput = { model: "m", answers: { x: { type: "choice", choice: "a" } } }

    expect(zenBodyOr(bad)).toBeUndefined()
  })

  it("rejects non-numeric noul values", () => {
    const bad: ZenBodyInput = { model: "m", answers: { x: { type: "noul", noul: "high" } } }

    expect(zenBodyOr(bad)).toBeUndefined()
  })

  it("rejects bodies without model or answers", () => {
    expect(zenBodyOr({ answers: {} })).toBeUndefined()
    expect(zenBodyOr({ model: "m" })).toBeUndefined()
    expect(zenBodyOr(undefined)).toBeUndefined()
  })
})

import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { JevRequest, JevResult, NoulAnswer, NoulQuestion } from "../src/types.ts"

describe("provider-neutral domain schemas", () => {
  it("accepts valid requests and results", () => {
    expect(Schema.is(JevRequest)({
      state: { action: "shell", resources: ["pwd"] },
      questions: {
        harmful: {
          type: "noul",
          instructions: "Could this cause harm?",
          criteria: { false: "No", true: "Yes" },
        },
      },
    })).toBe(true)

    expect(Schema.is(JevResult)({
      model: "jev-test",
      answers: { harmful: { type: "noul", noul: 0.1 } },
    })).toBe(true)
  })

  it("rejects malformed questions, answers, state, and results", () => {
    expect(Schema.is(NoulQuestion)({ type: "choice", instructions: "Choose" })).toBe(false)
    expect(Schema.is(NoulAnswer)({ type: "noul", noul: 1.1 })).toBe(false)
    expect(Schema.is(JevRequest)({ state: Number.NaN, questions: {} })).toBe(false)
    expect(Schema.is(JevResult)({ model: "", answers: {} })).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { combine, defaultThresholds } from "../../src/core/decision.ts"
import type { Judged, RiskAnswers } from "../../src/core/decision.ts"

const risk = (overrides: Partial<RiskAnswers> = {}): RiskAnswers => ({
  destructive: 0.01,
  sensitive: 0.01,
  executes: 0.01,
  network: 0.01,
  obfuscated: 0.01,
  ...overrides,
})

const judged = (r: RiskAnswers, context?: Judged["context"]): Judged => ({
  risk: r,
  context,
  model: "jev-1.13.0",
})

describe("combine - bands", () => {
  it("asks loudly when any axis reaches high risk", () => {
    const verdict = combine({ command: "rm -rf build" }, judged(risk({ destructive: 0.9 })))
    expect(verdict.effect).toBe("ask")
    expect(verdict.reason).toContain("high-risk")
    expect(verdict.reason).toContain("destructive")
  })

  it("allows when every axis is under the allow threshold", () => {
    const verdict = combine({ command: "ls src" }, judged(risk()))
    expect(verdict.effect).toBe("allow")
  })

  it("asks in the ask band", () => {
    const verdict = combine({ command: "npm install" }, judged(risk({ executes: 0.6 })))
    expect(verdict.effect).toBe("ask")
  })

  it("asks in the gray zone between allow and ask", () => {
    const verdict = combine({ command: "tar czf out.tgz ." }, judged(risk({ executes: 0.3 })))
    expect(verdict.effect).toBe("ask")
    expect(verdict.reason).toContain("gray zone")
  })
})

describe("combine - softening", () => {
  const context = { authorized: 0.95, off_task: 0.1 }

  it("softens ask to allow when the task authorizes", () => {
    const verdict = combine({ command: "npm install", task: "install deps" }, judged(risk({ executes: 0.6 }), context))
    expect(verdict.effect).toBe("allow")
    expect(verdict.reason).toContain("softened")
  })

  it("never softens a sensitive ask", () => {
    const verdict = combine({ command: "cat .env", task: "read config" }, judged(risk({ sensitive: 0.6 }), context))
    expect(verdict.effect).toBe("ask")
  })

  it("leaves verdicts unchanged without task context", () => {
    const verdict = combine({ command: "npm install" }, judged(risk({ executes: 0.6 })))
    expect(verdict.effect).toBe("ask")
  })
})

describe("combine - thresholds are the whole policy", () => {
  it("a boundary value exactly at high-risk threshold asks loudly", () => {
    const verdict = combine({ command: "x" }, judged(risk({ destructive: defaultThresholds.highRisk })))
    expect(verdict.effect).toBe("ask")
    expect(verdict.reason).toContain("high-risk")
  })

  it("a value just under the allow threshold still allows", () => {
    const verdict = combine({ command: "x" }, judged(risk({ network: defaultThresholds.allow - 0.001 })))
    expect(verdict.effect).toBe("allow")
  })
})

import { describe, expect, it } from "vitest"
import { hasExplicitAsk } from "../src/opencode/ask-rule.ts"

describe("OpenCode effective ask rules", () => {
  it("lets the catch-all shell ask reach Jevvy review", () => {
    const rules = [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "shell", resource: "*", effect: "ask" as const },
    ]

    expect(hasExplicitAsk("shell", ["pwd"], rules)).toBe(false)
  })

  it("preserves a human prompt when any scanner resource has a winning ask", () => {
    const rules = [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "shell", resource: "*", effect: "ask" as const },
      { action: "shell", resource: "pnpm build *", effect: "ask" as const },
    ]

    expect(hasExplicitAsk("shell", ["echo hello", "pnpm build"], rules)).toBe(true)
  })

  it("respects later agent and session rules", () => {
    const rules = [
      { action: "shell", resource: "*", effect: "ask" as const },
      { action: "shell", resource: "pnpm *", effect: "ask" as const },
      { action: "shell", resource: "pnpm build", effect: "allow" as const },
    ]

    expect(hasExplicitAsk("shell", ["pnpm build"], rules)).toBe(false)
    expect(hasExplicitAsk("shell", ["pnpm test"], rules)).toBe(true)
  })

  it("keeps wildcard action asks human-only instead of treating them as a shell baseline", () => {
    expect(hasExplicitAsk("shell", ["pwd"], [
      { action: "*", resource: "*", effect: "ask" },
    ])).toBe(true)
  })

  it("uses the last matching rule even when a session restores the review baseline", () => {
    expect(hasExplicitAsk("shell", ["git push origin main"], [
      { action: "shell", resource: "git push *", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
    ])).toBe(false)
  })

  it("matches OpenCode's whole-value wildcard semantics", () => {
    const rules = [{ action: "shell", resource: "git push *", effect: "ask" as const }]

    expect(hasExplicitAsk("shell", ["git push"], rules)).toBe(true)
    expect(hasExplicitAsk("shell", ["git push origin main"], rules)).toBe(true)
    expect(hasExplicitAsk("shell", ["git status && git push origin main"], rules)).toBe(false)
  })
})

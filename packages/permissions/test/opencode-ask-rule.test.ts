import { describe, expect, it } from "vitest"
import { hasExplicitAsk } from "../src/opencode/ask-rule.ts"

describe("OpenCode effective ask rules", () => {
  it("preserves a human prompt when any scanner resource has a winning ask", () => {
    const rules = [
      { action: "*", resource: "*", effect: "allow" as const },
      { action: "shell", resource: "pnpm build *", effect: "ask" as const },
    ]

    expect(hasExplicitAsk("shell", ["echo hello", "pnpm build"], rules)).toBe(true)
  })

  it("respects later agent and session rules", () => {
    const rules = [
      { action: "shell", resource: "pnpm *", effect: "ask" as const },
      { action: "shell", resource: "pnpm build", effect: "allow" as const },
    ]

    expect(hasExplicitAsk("shell", ["pnpm build"], rules)).toBe(false)
    expect(hasExplicitAsk("shell", ["pnpm test"], rules)).toBe(true)
  })

  it("matches OpenCode's whole-value wildcard semantics", () => {
    const rules = [{ action: "shell", resource: "git push *", effect: "ask" as const }]

    expect(hasExplicitAsk("shell", ["git push"], rules)).toBe(true)
    expect(hasExplicitAsk("shell", ["git push origin main"], rules)).toBe(true)
    expect(hasExplicitAsk("shell", ["git status && git push origin main"], rules)).toBe(false)
  })
})

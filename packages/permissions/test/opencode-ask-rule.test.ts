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

  it("delegates a generic catch-all only when its resource pattern is nominated", () => {
    const rules = [{ action: "*", resource: "*", effect: "ask" as const }]

    expect(hasExplicitAsk("shell", ["pwd"], rules, [])).toBe(true)
    expect(hasExplicitAsk("shell", ["pwd"], rules, ["*"])).toBe(false)
  })

  it("delegates nominated specific asks without adding a command allowlist", () => {
    const rules = [
      { action: "*", resource: "*", effect: "ask" as const },
      { action: "shell", resource: "npm run *", effect: "ask" as const },
      { action: "shell", resource: "sudo*", effect: "ask" as const },
    ]

    expect(hasExplicitAsk("shell", ["npm run build"], rules, ["npm run *"])).toBe(false)
    expect(hasExplicitAsk("shell", ["pwd"], rules, ["npm run *"])).toBe(true)
    expect(hasExplicitAsk("shell", ["sudo ls"], rules, ["*", "npm run *"])).toBe(true)
    expect(hasExplicitAsk("shell", ["sudo ls"], rules, ["sudo*"])).toBe(false)
  })

  it.each([
    ["pwd", "**", "*"],
    ["git status", "git status *", "git *"],
    ["GIT status", "GIT *", "git *"],
    ["tools/run", "tools\\*", "tools/*"],
    ["git status ", "git * ", "git *"],
  ])("compares the winning pattern literally for %s", (resource, pattern, nomination) => {
    const rules = [{ action: "*", resource: pattern, effect: "ask" as const }]

    expect(hasExplicitAsk("shell", [resource], rules, [nomination])).toBe(true)
    expect(hasExplicitAsk("shell", [resource], rules, [pattern])).toBe(false)
  })

  it.each(["*", "sh*", "shell"])("delegates matching %s action rules only on shell events", (action) => {
    const rules = [{ action, resource: "npm run *", effect: "ask" as const }]

    expect(hasExplicitAsk("shell", ["npm run build"], rules, ["npm run *"])).toBe(false)
    expect(hasExplicitAsk("shell", ["npm run build"], rules, [])).toBe(true)
    expect(hasExplicitAsk("shell", ["npm run build"], rules, ["npm run *", "npm run *"])).toBe(false)
  })

  it("leaves non-shell asks with the host even when the same pattern is nominated", () => {
    const rules = [{ action: "*", resource: "*", effect: "ask" as const }]

    expect(hasExplicitAsk("edit", ["file.ts"], rules, ["*"])).toBe(true)
    expect(hasExplicitAsk("read", ["file.ts"], rules, ["*"])).toBe(true)
  })

  it("retains last-match ordering rather than preserving every earlier ask", () => {
    const generic = { action: "*", resource: "*", effect: "ask" as const }
    const specific = { action: "shell", resource: "sudo*", effect: "ask" as const }

    expect(hasExplicitAsk("shell", ["sudo ls"], [generic, specific], ["*"])).toBe(true)
    expect(hasExplicitAsk("shell", ["sudo ls"], [specific, generic], ["*"])).toBe(false)
  })

  it("keeps a whole request host-owned if any winning ask is unlisted", () => {
    const rules = [
      { action: "*", resource: "*", effect: "ask" as const },
      { action: "shell", resource: "sudo*", effect: "ask" as const },
    ]

    expect(hasExplicitAsk("shell", ["pwd", "sudo ls"], rules, ["*"])).toBe(true)
    expect(hasExplicitAsk("shell", ["pwd", "sudo ls"], rules, ["*", "sudo*"])).toBe(false)
  })

  it("keeps the existing shell invitation and implicit asks unchanged", () => {
    expect(hasExplicitAsk("shell", ["pwd"], [{ action: "shell", resource: "*", effect: "ask" }], [])).toBe(false)
    expect(hasExplicitAsk("shell", ["pwd"], [], ["*"])).toBe(false)
    expect(hasExplicitAsk("shell", ["pwd"], [{ action: "shell", resource: "*", effect: "allow" }], ["*"])).toBe(false)
    expect(hasExplicitAsk("shell", ["pwd"], [{ action: "shell", resource: "*", effect: "deny" }], ["*"])).toBe(false)
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

import { describe, expect, it } from "vitest"
import { isRememberedApproval, matchesApprovalPattern } from "../../src/plugin/approvals.ts"

describe("saved approvals", () => {
  it("matches exact and wildcard resources across the full string", () => {
    expect(matchesApprovalPattern("grep *", "grep -F needle README.md")).toBe(true)
    expect(matchesApprovalPattern("grep *", "xgrep -F needle README.md")).toBe(false)
    expect(matchesApprovalPattern("git status", "git status")).toBe(true)
    expect(matchesApprovalPattern("git status", "git status --short")).toBe(false)
    expect(matchesApprovalPattern("file?.txt", "file1.txt")).toBe(true)
    expect(matchesApprovalPattern("file?.txt", "file12.txt")).toBe(false)
  })

  it("matches OpenCode shell prefixes with or without arguments", () => {
    expect(matchesApprovalPattern("git status *", "git status", true)).toBe(true)
    expect(matchesApprovalPattern("git status *", "git status --short", true)).toBe(true)
    expect(matchesApprovalPattern("git status *", "git status", false)).toBe(false)
  })

  it("requires every resource to have an approval for the same action", () => {
    const approvals = [
      { action: "shell", resource: "grep *" },
      { action: "shell", resource: "tail *" },
      { action: "read", resource: "*" },
    ]

    expect(isRememberedApproval(approvals, "shell", ["grep x file", "tail -1 file"])).toBe(true)
    expect(isRememberedApproval(approvals, "shell", ["grep"])).toBe(true)
    expect(isRememberedApproval(approvals, "shell", ["grep x file", "rm file"])).toBe(false)
    expect(isRememberedApproval(approvals, "shell", [])).toBe(false)
  })
})

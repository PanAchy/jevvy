import { describe, expect, it } from "vitest"

import { formatReleaseTitle } from "../scripts/rename-github-releases.mjs"

describe("GitHub release titles", () => {
  it("includes the Jevvy package name", () => {
    expect(formatReleaseTitle({ name: "@jevvy/permissions", version: "0.2.0" })).toBe(
      "Jevvy Permissions 0.2.0",
    )
  })

  it("separates words in future package names", () => {
    expect(formatReleaseTitle({ name: "@jevvy/codex-harness", version: "1.0.0" })).toBe(
      "Jevvy Codex Harness 1.0.0",
    )
  })
})

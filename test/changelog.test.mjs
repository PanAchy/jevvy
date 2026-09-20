import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { omitIgnoredThanks } from "../.changeset/changelog.mjs"

const owner = "[@PanAchy](https://github.com/PanAchy)"

const contributor = "[@contributor](https://github.com/contributor)"

describe("Changesets changelog attribution", () => {
  it("omits thanks for the repository owner", () => {
    const line = `- [#1](pull) Thanks ${owner}! - Release Jevvy`

    expect(omitIgnoredThanks(line, ["PanAchy"])).toBe("- [#1](pull) - Release Jevvy")
  })

  it("keeps thanks for a contributor", () => {
    const line = `- [#2](pull) Thanks ${contributor}! - Improve Jevvy`

    expect(omitIgnoredThanks(line, ["PanAchy"])).toBe(line)
  })

  it("keeps contributors when the owner is one of multiple authors", () => {
    const line = `- [#3](pull) Thanks ${owner}, ${contributor}! - Improve Jevvy together`

    expect(omitIgnoredThanks(line, ["PanAchy"])).toBe(
      `- [#3](pull) Thanks ${contributor}! - Improve Jevvy together`,
    )
  })
})

describe("public release notes", () => {
  it("uses user-facing headings in the newest release", () => {
    const changelog = readFileSync(new URL("../packages/permissions/CHANGELOG.md", import.meta.url), "utf8")
    const newestRelease = changelog.split(/^## /mu)[1]

    expect(newestRelease).toBeDefined()
    expect(newestRelease).not.toMatch(/^### (?:Major|Minor|Patch) Changes$/mu)
  })
})

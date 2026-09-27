import { describe, expect, it } from "vitest"
import { colorizeAccent } from "../src/init/theme.ts"

describe("init accent", () => {
  it("keeps text plain without color support", () => {
    expect(colorizeAccent("Set up Jevvy", 1)).toBe("Set up Jevvy")
  })

  it("uses the social-preview violet with truecolor support", () => {
    expect(colorizeAccent("Set up Jevvy", 24)).toBe("\u001b[38;2;164;144;249mSet up Jevvy\u001b[39m")
  })

  it("uses violet approximations in older terminals", () => {
    expect(colorizeAccent("Jevvy", 8)).toBe("\u001b[38;5;141mJevvy\u001b[39m")
    expect(colorizeAccent("Jevvy", 4)).toBe("\u001b[95mJevvy\u001b[39m")
  })
})

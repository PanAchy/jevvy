import { describe, expect, it, vi } from "vitest"
import { paint, promptFrame } from "../src/init/layout.ts"
import { accent, colorizeAccent, terminalPalette } from "../src/init/theme.ts"

describe("init accent", () => {
  it("keeps text plain without color support", () => {
    expect(colorizeAccent("Set up Jevvy Permissions", 1)).toBe("Set up Jevvy Permissions")
  })

  it("uses the social-preview violet with truecolor support", () => {
    expect(colorizeAccent("Set up Jevvy Permissions", 24)).toBe("\u001b[38;2;164;144;249mSet up Jevvy Permissions\u001b[39m")
  })

  it("uses violet approximations in older terminals", () => {
    expect(colorizeAccent("Jevvy", 8)).toBe("\u001b[38;5;141mJevvy\u001b[39m")
    expect(colorizeAccent("Jevvy", 4)).toBe("\u001b[95mJevvy\u001b[39m")
  })

  it("respects stdout color depth, non-TTY output, and NO_COLOR without leaving global changes", () => {
    const descriptors = [
      ["isTTY", Object.getOwnPropertyDescriptor(process.stdout, "isTTY")],
      ["getColorDepth", Object.getOwnPropertyDescriptor(process.stdout, "getColorDepth")],
    ] as const

    try {
      vi.stubEnv("NO_COLOR", undefined)

      for (const depth of [1, 4, 8, 24]) {
        Object.defineProperties(process.stdout, {
          isTTY: { value: true, configurable: true },
          getColorDepth: { value: () => depth, configurable: true },
        })
        const colors = terminalPalette()

        expect(accent("Question")).toBe(colorizeAccent("Question", depth))
        expect(paint("Question", colors.primary)).toBe(colorizeAccent("Question", depth))

        if (depth >= 4) {
          expect(colors.secondary).toBe(depth >= 24 ? "\u001b[38;2;134;213;199m" : depth >= 8 ? "\u001b[38;5;116m" : "\u001b[96m")
        }
      }

      for (const tty of [false, true]) {
        Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true })
        vi.stubEnv("NO_COLOR", tty ? "" : undefined)
        const colors = terminalPalette()

        expect(colors).toEqual({ primary: "", secondary: "", muted: "", error: "", foreground: "" })
        expect(accent("Question")).toBe("Question")
        expect(promptFrame("Question", [paint("Answer", colors.muted)], 20, colors, true)).toBe("◇  Question\n│  Answer\n│\n")
      }
    } finally {
      vi.unstubAllEnvs()

      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(process.stdout, name)
        else Object.defineProperty(process.stdout, name, descriptor)
      }
    }
  })
})

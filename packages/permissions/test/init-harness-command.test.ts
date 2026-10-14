import { describe, expect, it } from "@effect/vitest"
import { harnessCommand } from "../src/init/harness-command.ts"

describe("setup installer commands", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    it(`supports trusted installer arguments on ${platform}`, () => {
      for (const [harness, args] of [
        ["opencode", ["plugin", "add", "@jevvy/permissions"]],
        ["claude", ["plugin", "marketplace", "add", "--scope", "user", "PanAchy/jevvy"]],
        ["claude", ["plugin", "install", "--scope", "user", "jevvy-permissions@jevvy"]],
      ] as const) {
        const command = harnessCommand(harness, args, { platform, inherit: true })

        expect(command.command).toBe(harness)
        expect(command.args).toEqual(args)
        expect(command.options.shell).toBe(platform === "win32")
        expect(command.options.stdin).toBe("inherit")
        expect(command.options.stdout).toBe("inherit")
        expect(command.options.stderr).toBe("inherit")
      }
    })
  }
})

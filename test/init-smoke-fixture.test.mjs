import { describe, expect, it } from "vitest"
import { windowsHostFixture } from "../scripts/init-smoke-fixture.ts"

describe("Windows packed setup fixture", () => {
  for (const host of ["opencode", "claude"]) {
    it(`keeps the ${host} batch source ASCII while preserving the Unicode Node path in its environment`, () => {
      const nodePath = String.raw`C:\interactive setup ü\Node 安装\node.exe`
      const fixture = windowsHostFixture(nodePath)
      const source = fixture.source(host)

      expect(fixture.environment).toEqual({ JEVVY_SMOKE_NODE: nodePath })
      expect([...Buffer.from(source)].every((byte) => byte <= 0x7f)).toBe(true)
      expect(source).toBe(`@echo off\r\n"%JEVVY_SMOKE_NODE%" "%~dp0fake-host.mjs" ${host} %*\r\n`)
      expect(source).not.toContain(nodePath)
    })
  }
})

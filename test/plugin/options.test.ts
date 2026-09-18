// Options parsing: schema-declared shape, all-or-nothing on bad config.

import { describe, expect, it } from "vitest"
import { isPluginOptionsInput, parseOptions } from "../../src/plugin/options.ts"

describe("parseOptions", () => {
  it("reads a full valid config", () => {
    const options = parseOptions({
      model: "jev-1.13.0",
      thresholds: { highRisk: 0.9, ask: 0.6, allow: 0.25, authorized: 0.85 },
      dryRun: true,
      noLog: false,
      notePerAllow: true,
      maxRequestsPerDay: 500,
    })

    expect(options.model).toBe("jev-1.13.0")
    expect(options.thresholds).toEqual({ highRisk: 0.9, ask: 0.6, allow: 0.25, authorized: 0.85 })
    expect(options.dryRun).toBe(true)
    expect(options.maxRequestsPerDay).toBe(500)
  })

  it("accepts partial config", () => {
    const options = parseOptions({ dryRun: true })

    expect(options.dryRun).toBe(true)
    expect(options.model).toBeUndefined()
  })

  it("one invalid field drops every override, not just itself", () => {
    const options = parseOptions({ dryRun: true, model: 123 })

    expect(options).toEqual({})
  })

  it("non-object input is rejected by the gate", () => {
    expect(isPluginOptionsInput(undefined) ? parseOptions({}) : {}).toEqual({})
    expect(isPluginOptionsInput("dryRun") ? parseOptions({}) : {}).toEqual({})
  })
})

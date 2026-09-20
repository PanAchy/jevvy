import { describe, expect, it } from "vitest"
import { missingProviderMessage } from "../src/calibration-cli.ts"

describe("calibration command", () => {
  it("reports the Vercel credential sources", () => {
    expect(missingProviderMessage("vercel")).toBe(
      "Vercel calibration needs providers.vercel.apiKey or AI_GATEWAY_API_KEY",
    )
  })
})

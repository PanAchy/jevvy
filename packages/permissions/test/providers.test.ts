import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_LAYA_ENDPOINT,
  DEFAULT_LAYA_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
} from "../src/core.ts"
import { createConfiguredProvider, providerDisplayName, shippedPolicyProvenance } from "../src/providers.ts"
import { readFileSync } from "node:fs"

describe("configured provider creation", () => {
  it("keeps the published scoped settings schema aligned with runtime constraints", () => {
    const document = JSON.parse(readFileSync(new URL("../../../config.schema.json", import.meta.url), "utf8"))
    expect(document.$defs.systemOnePresetSettings).toEqual({
      type: "object", additionalProperties: false,
      properties: {
        apiKey: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        opencodeCredential: {
          type: "string",
          minLength: 1,
          description: "OpenCode integration ID whose stored API key Jevvy reads when apiKey and the provider environment variable are absent. OpenCode only.",
        },
      },
    })

    for (const provider of ["zen", "typesafe", "openrouter", "vercel"]) {
      expect(document.properties.providers.properties[provider]).toEqual({ $ref: "#/$defs/systemOnePresetSettings" })
    }
  })

  it.each([
    ["zen", "jev-1.13-free"], ["typesafe", DEFAULT_TYPESAFE_MODEL],
    ["openrouter", DEFAULT_OPENROUTER_MODEL], ["vercel", DEFAULT_VERCEL_MODEL],
  ] as const)("preserves only the existing calibrated %s route attribution", (provider, model) => {
    expect(shippedPolicyProvenance({ provider, model })).toBe("calibrated-defaults")

    for (const alias of ["arbitrary", `${model}-20261018`, `typesafe/${model}`, "jev-looking-alias"]) {
      expect(shippedPolicyProvenance({ provider, model: alias })).toBe("shipped-defaults-unverified")
    }
  })

  it("does not infer calibration from the new paid Zen default", () => {
    expect(DEFAULT_ZEN_MODEL).toBe("jev-1.13")
    const selected = createConfiguredProvider({ provider: "zen", apiKey: Redacted.make("test-key") })

    if (selected === undefined) throw new Error("Expected provider")
    expect(shippedPolicyProvenance(selected)).toBe("shipped-defaults-unverified")
    expect(shippedPolicyProvenance({ provider: "zen", model: "jev-1.13" })).toBe("shipped-defaults-unverified")
    expect(shippedPolicyProvenance({ provider: "custom", model: "jev-1.13-free" })).toBe("shipped-defaults-unverified")
    expect(shippedPolicyProvenance({ provider: "laya", model: "jev-1.13-free" })).toBe("shipped-defaults-unverified")
  })
  it.each([
    ["zen", DEFAULT_ZEN_MODEL],
    ["typesafe", DEFAULT_TYPESAFE_MODEL],
    ["openrouter", DEFAULT_OPENROUTER_MODEL],
    ["vercel", DEFAULT_VERCEL_MODEL],
  ] as const)("constructs the explicitly selected %s provider", (provider, model) => {
    const selected = createConfiguredProvider({
      provider,
      apiKey: Redacted.make(`${provider}-key`),
    })

    expect(selected).toMatchObject({ provider, model })
  })

  it("does not fall back when the selected provider has no credential", () => {
    expect(createConfiguredProvider({ provider: "typesafe" })).toBeUndefined()
  })

  it("constructs a custom provider without a credential", () => {
    const selected = createConfiguredProvider({
      provider: "custom",
      endpoint: "http://127.0.0.1:8080/v1/decisions",
      model: "laya-typed-decisions",
    })

    expect(selected).toMatchObject({
      provider: "custom",
      model: "laya-typed-decisions",
    })
  })

  it("constructs the local Laya provider without a credential", () => {
    const selected = createConfiguredProvider({ provider: "laya" })

    expect(selected).toMatchObject({ provider: "laya", model: DEFAULT_LAYA_MODEL })
    expect(DEFAULT_LAYA_ENDPOINT).toBe("http://127.0.0.1:8000/v1/systemone")
  })

  it("labels Laya independently of where its endpoint runs", () => {
    expect(providerDisplayName("laya")).toBe("Laya")
  })

  it("redacts configured credentials without exposing them to callers", () => {
    const selected = createConfiguredProvider({
      provider: "custom",
      endpoint: "https://api.aimlapi.com/v1/decisions",
      model: "typesafe/jev",
      apiKey: Redacted.make("secret"),
    })

    expect(selected?.redact("provider rejected secret")).toBe("provider rejected [redacted]")
  })
})

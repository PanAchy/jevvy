import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
} from "../src/core.ts"
import { createConfiguredProvider } from "../src/providers.ts"

describe("configured provider creation", () => {
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

import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_LAYA_ENDPOINT,
  DEFAULT_LAYA_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
} from "../src/core.ts"
import { createConfiguredProvider, providerDisplayName, providerSetupChoices, shippedPolicyProvenance } from "../src/providers.ts"
import { JevProvider } from "../src/core.ts"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"

describe("configured provider creation", () => {
  it("keeps runtime providers, public schema, and searchable setup choices in sync", () => {
    const document = JSON.parse(readFileSync(new URL("../../../config.schema.json", import.meta.url), "utf8"))
    const names = providerSetupChoices.map(({ value }) => value).sort()

    expect(names).toEqual(document.properties.provider.enum.toSorted())

    for (const name of names) {
      expect(Schema.is(JevProvider)(name)).toBe(true)
      expect(document.properties.providers.properties[name]).toBeDefined()
    }
  })

  it.each(["openai", "microsoft", "custom", "laya"] as const)("does not attribute Jev's shipped calibration to %s", (provider) => {
    expect(shippedPolicyProvenance(provider)).toBe("shipped-defaults-unverified")
  })

  it.each(["typesafe", "zen", "openrouter", "vercel"] as const)("preserves Jev calibration labels for %s", (provider) => {
    expect(shippedPolicyProvenance(provider)).toBe("calibrated-defaults")
  })
  it.each([
    ["zen", DEFAULT_ZEN_MODEL],
    ["typesafe", DEFAULT_TYPESAFE_MODEL],
    ["openrouter", DEFAULT_OPENROUTER_MODEL],
    ["vercel", DEFAULT_VERCEL_MODEL],
    ["openai", DEFAULT_OPENAI_MODEL],
  ] as const)("constructs the explicitly selected %s provider", (provider, model) => {
    const selected = createConfiguredProvider({
      provider,
      apiKey: Redacted.make(`${provider}-key`),
    })

    expect(selected).toMatchObject({ provider, model })
  })

  it("does not fall back when the selected provider has no credential", () => {
    expect(createConfiguredProvider({ provider: "typesafe" })).toBeUndefined()
    expect(createConfiguredProvider({ provider: "openai" })).toBeUndefined()
    expect(createConfiguredProvider({ provider: "microsoft", endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment" })).toBeUndefined()
  })

  it("constructs Microsoft with the configured deployment, not a catalog model ID", () => {
    const selected = createConfiguredProvider({
      provider: "microsoft", endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment",
      apiKey: Redacted.make("azure-secret"),
    })

    expect(selected).toMatchObject({ provider: "microsoft", model: "deployment" })
    expect(selected?.redact("Invalid azure-secret")).toBe("Invalid [redacted]")
    expect(providerDisplayName("microsoft")).toBe("Microsoft Decision")
    expect(providerDisplayName("openai")).toBe("OpenAI Decisions")
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

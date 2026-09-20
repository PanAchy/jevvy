import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TYPESAFE_MODEL,
  DEFAULT_VERCEL_MODEL,
  DEFAULT_ZEN_MODEL,
} from "../src/core.ts"
import { selectConfiguredProvider } from "../src/providers.ts"

describe("configured provider selection", () => {
  it("uses Zen first in automatic mode", () => {
    const selected = selectConfiguredProvider("auto", {
      zen: Redacted.make("zen-key"),
      typesafe: Redacted.make("typesafe-key"),
      openrouter: Redacted.make("openrouter-key"),
      vercel: Redacted.make("vercel-key"),
    })

    expect(selected).toMatchObject({ provider: "zen", model: DEFAULT_ZEN_MODEL })
  })

  it("preserves TypeSafe precedence over OpenRouter in automatic mode", () => {
    const selected = selectConfiguredProvider("auto", {
      typesafe: Redacted.make("typesafe-key"),
      openrouter: Redacted.make("openrouter-key"),
      vercel: Redacted.make("vercel-key"),
    })

    expect(selected).toMatchObject({ provider: "typesafe", model: DEFAULT_TYPESAFE_MODEL })
  })

  it("preserves OpenRouter precedence over Vercel in automatic mode", () => {
    const selected = selectConfiguredProvider("auto", {
      openrouter: Redacted.make("openrouter-key"),
      vercel: Redacted.make("vercel-key"),
    })

    expect(selected).toMatchObject({ provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL })
  })

  it("honors an explicit provider preference", () => {
    const selected = selectConfiguredProvider("typesafe", {
      zen: Redacted.make("zen-key"),
      typesafe: Redacted.make("typesafe-key"),
    })

    expect(selected).toMatchObject({ provider: "typesafe", model: DEFAULT_TYPESAFE_MODEL })
  })

  it("constructs an explicitly selected OpenRouter provider", () => {
    const selected = selectConfiguredProvider("openrouter", {
      openrouter: Redacted.make("openrouter-key"),
    })

    expect(selected).toMatchObject({ provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL })
  })

  it("constructs an explicitly selected Vercel provider", () => {
    const selected = selectConfiguredProvider("vercel", {
      vercel: Redacted.make("vercel-key"),
    })

    expect(selected).toMatchObject({ provider: "vercel", model: DEFAULT_VERCEL_MODEL })
  })

  it("uses Vercel as the final automatic fallback", () => {
    const selected = selectConfiguredProvider("auto", {
      vercel: Redacted.make("vercel-key"),
    })

    expect(selected).toMatchObject({ provider: "vercel", model: DEFAULT_VERCEL_MODEL })
  })

  it("returns undefined when the preferred credential is unavailable", () => {
    expect(selectConfiguredProvider("typesafe", {
      zen: Redacted.make("zen-key"),
    })).toBeUndefined()
  })

  it("redacts its credential without exposing it to callers", () => {
    const selected = selectConfiguredProvider("zen", { zen: Redacted.make("secret") })

    expect(selected?.redact("provider rejected secret")).toBe("provider rejected [redacted]")
  })
})

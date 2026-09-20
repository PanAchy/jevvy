import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { DEFAULT_TYPESAFE_MODEL, DEFAULT_ZEN_MODEL } from "../src/core.ts"
import { selectConfiguredProvider } from "../src/providers.ts"

describe("configured provider selection", () => {
  it("uses Zen before TypeSafe in automatic mode", () => {
    const selected = selectConfiguredProvider("auto", {
      zen: Redacted.make("zen-key"),
      typesafe: Redacted.make("typesafe-key"),
    })

    expect(selected).toMatchObject({ provider: "zen", model: DEFAULT_ZEN_MODEL })
  })

  it("honors an explicit provider preference", () => {
    const selected = selectConfiguredProvider("typesafe", {
      zen: Redacted.make("zen-key"),
      typesafe: Redacted.make("typesafe-key"),
    })

    expect(selected).toMatchObject({ provider: "typesafe", model: DEFAULT_TYPESAFE_MODEL })
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

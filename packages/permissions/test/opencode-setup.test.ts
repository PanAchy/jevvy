import { describe, expect, it } from "@effect/vitest"
import {
  missingConfigurationMessage,
  missingCredentialMessage,
} from "../src/opencode/setup.ts"

describe("OpenCode setup guidance", () => {
  it("explains assisted and manual setup when no provider is configured", () => {
    const path = "/home/user/.config/jevvy/jevvy.jsonc"

    expect(missingConfigurationMessage(path)).toBe(
      `Jevvy cannot start because no provider is configured. Run "npx @jevvy/permissions init", or create ${path} manually. OpenCode's remaining permission flow remains unchanged.`,
    )
  })

  it.each([
    ["zen", "OpenCode Zen", "OPENCODE_API_KEY", "providers.zen.apiKey"],
    ["typesafe", "TypeSafe AI", "TYPESAFE_API_KEY", "providers.typesafe.apiKey"],
    ["openrouter", "OpenRouter", "OPENROUTER_API_KEY", "providers.openrouter.apiKey"],
    ["vercel", "Vercel AI Gateway", "AI_GATEWAY_API_KEY", "providers.vercel.apiKey"],
  ] as const)("explains how to configure missing %s credentials", (provider, label, environment, config) => {
    const message = missingCredentialMessage(provider, "/home/user/.config/jevvy/jevvy.jsonc")

    expect(message).toContain(label)
    expect(message).toContain(environment)
    expect(message).toContain(config)
    expect(message).toContain("npx @jevvy/permissions init")
    expect(message).toContain("OpenCode's remaining permission flow remains unchanged")
    expect(message).not.toContain("opencode auth login")
  })
})

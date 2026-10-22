import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { Integration } from "@opencode/schema/integration"
import { apiKeyFromCredential, withOpenCodeCredential } from "../src/opencode/credential.ts"

const selection = (opencodeCredential?: string) => ({
  provider: "openrouter" as const,
  opencodeCredential,
})

const valueOf = (selection: { readonly apiKey?: Redacted.Redacted<string> }) =>
  selection.apiKey === undefined ? undefined : Redacted.value(selection.apiKey)

describe("OpenCode credential", () => {
  it("accepts only key credentials", () => {
    expect(apiKeyFromCredential({ type: "key", key: " sk-or-v1-test " })).toBe("sk-or-v1-test")
    expect(apiKeyFromCredential({ type: "key", key: "   " })).toBeUndefined()
    expect(apiKeyFromCredential({ type: "oauth", methodID: Integration.MethodID.make("oauth"), refresh: "fixture-refresh", access: "fixture-access", expires: 0 })).toBeUndefined()
    expect(apiKeyFromCredential(undefined)).toBeUndefined()
  })

  it.effect("resolves the named integration", () => Effect.gen(function*() {
    const calls: string[] = []

    const resolved = yield* withOpenCodeCredential(selection("openrouter"), (integrationID) => Effect.sync(() => {
      calls.push(integrationID)

      return "sk-or-v1-test"
    }))

    expect(calls).toEqual(["openrouter"])
    expect(valueOf(resolved)).toBe("sk-or-v1-test")
  }))

  it.effect("keeps an explicit API key", () => Effect.gen(function*() {
    const resolved = yield* withOpenCodeCredential(
      { ...selection("openrouter"), apiKey: Redacted.make("file-key") },
      () => Effect.sync(() => {
        throw new Error("unexpected resolution")
      }),
    )

    expect(valueOf(resolved)).toBe("file-key")
  }))

  it.effect("does nothing without an integration id", () => Effect.gen(function*() {
    const resolved = yield* withOpenCodeCredential(selection(), () => Effect.sync(() => {
      throw new Error("unexpected resolution")
    }))

    expect(resolved.apiKey).toBeUndefined()
  }))

  it.effect("abstains when resolution fails", () => Effect.gen(function*() {
    const resolved = yield* withOpenCodeCredential(selection("openrouter"), () => Effect.fail(new Error("offline")))

    expect(resolved.apiKey).toBeUndefined()
  }))
})

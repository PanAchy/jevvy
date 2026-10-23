import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { createPermissionReviewer } from "../src/engine.ts"
import { createConfiguredProvider } from "../src/providers.ts"

const response = (provider: "openai" | "microsoft", probability: number) => provider === "openai"
  ? {
      model: "gpt-6-luna",
      answers: [
        { type: "predicate", name: "harmful", probability },
        { type: "predicate", name: "sensitive", probability: 0.01 },
        { type: "predicate", name: "untrusted", probability: 0.01 },
        { type: "predicate", name: "obscured", probability: 0.01 },
      ],
    }
  : {
      model: "microsoft-decision-1",
      answers: {
        harmful: { type: "noul", noul: probability },
        sensitive: { type: "noul", noul: 0.01 },
        untrusted: { type: "noul", noul: 0.01 },
        obscured: { type: "noul", noul: 0.01 },
      },
    }

describe("decision provider permission flow with synthetic scores", () => {
  it.effect.each(["openai", "microsoft"] as const)("applies unchanged thresholds through the configured %s adapter", (provider) => Effect.gen(function*() {
    const selected = createConfiguredProvider(provider === "openai"
      ? { provider, apiKey: Redacted.make("fixture-key") }
      : { provider, endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment", apiKey: Redacted.make("fixture-key") })

    if (selected === undefined) throw new Error("Expected configured provider")

    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(response(provider, 0.01)))
      .mockResolvedValueOnce(Response.json(response(provider, 0.36)))

    const reviewer = yield* createPermissionReviewer(selected.client)

    const low = yield* reviewer.review({ action: "shell", resources: ["pwd"] }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    const high = yield* reviewer.review({ action: "shell", resources: ["git status"] }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    expect(low).toMatchObject({ effect: "allow" })
    expect(high).toMatchObject({ effect: "ask", reason: "judged" })
    expect(transport).toHaveBeenCalledTimes(2)
  }))

  it.effect("abstains on a refused OpenAI question without caching the unavailable result", () => Effect.gen(function*() {
    const selected = createConfiguredProvider({ provider: "openai", apiKey: Redacted.make("fixture-key") })

    if (selected === undefined) throw new Error("Expected configured provider")

    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ model: "gpt-6-luna", answers: [{ type: "refusal", name: "harmful" }] }))
      .mockResolvedValueOnce(Response.json(response("openai", 0.01)))

    const reviewer = yield* createPermissionReviewer(selected.client)

    const unavailable = yield* reviewer.review({ action: "shell", resources: ["pwd"] }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    const available = yield* reviewer.review({ action: "shell", resources: ["pwd"] }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )

    expect(unavailable).toMatchObject({ effect: "ask", reason: "unavailable", failure: { provider: "openai", kind: "invalid-response" } })
    expect(available).toMatchObject({ effect: "allow" })
    expect(transport).toHaveBeenCalledTimes(2)
  }))
})

import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { createPermissionReviewer } from "../src/engine.ts"
import { createConfiguredProvider } from "../src/providers.ts"
import { renderJevvyConfig } from "../src/init/index.ts"
import { promptCloudflareProvider, initPlanSummary } from "../src/init/prompt.ts"

const accountId = "0123456789abcdef0123456789abcdef"

const response = (probability: number) => ({
  success: true, errors: [],
  result: {
    model: "clef",
    answers: Object.fromEntries(["harmful", "sensitive", "untrusted", "obscured"].map((name) => [name, { type: "noul", noul: probability }])),
  },
})

describe("experimental Cloudflare provider", () => {
  it.effect("uses the ordinary allow-only engine and does not cache malformed provider answers", () => Effect.gen(function*() {
    const selected = createConfiguredProvider({ provider: "cloudflare", accountId, apiKey: Redacted.make("fixture-token") })

    if (selected === undefined) throw new Error("Expected Cloudflare provider")

    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false, errors: [] }))
      .mockResolvedValueOnce(Response.json(response(0.01)))
      .mockResolvedValueOnce(Response.json(response(0.99)))

    const reviewer = yield* createPermissionReviewer(selected.client)
    const review = (command: string) => reviewer.review({ action: "shell", resources: [command] }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))

    expect(yield* review("pwd")).toMatchObject({ effect: "ask", reason: "unavailable", failure: { provider: "cloudflare", kind: "invalid-response" } })
    expect(yield* review("pwd")).toMatchObject({ effect: "allow" })
    expect(yield* review("pwd")).toMatchObject({ effect: "allow" })
    expect(yield* review("rm important.txt")).toMatchObject({ effect: "ask", reason: "judged" })
    expect(transport).toHaveBeenCalledTimes(3)
  }))

  it.effect("abstains on long commands rather than sending a truncatable command prefix", () => Effect.gen(function*() {
    const selected = createConfiguredProvider({ provider: "cloudflare", accountId, apiKey: Redacted.make("fixture-token") })

    if (selected === undefined) throw new Error("Expected Cloudflare provider")

    const transport = vi.fn<typeof fetch>()
    const reviewer = yield* createPermissionReviewer(selected.client)
    expect(yield* reviewer.review({ action: "shell", resources: [`echo ${"a".repeat(8_192)}; rm important.txt`] }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
    )).toMatchObject({ effect: "ask", reason: "unavailable", failure: { provider: "cloudflare", kind: "invalid-request" } })
    expect(transport).not.toHaveBeenCalled()
  }))

  it.effect("collects an account, an explicit model, and a private token during setup", () => Effect.gen(function*() {
    const prompts = {
      text: vi.fn(() => Effect.succeed(` ${accountId} `)),
      select: vi.fn(() => Effect.succeed("clef-flash" as const)),
      password: vi.fn(() => Effect.succeed(Redacted.make("private-token"))),
    }

    const provider = yield* promptCloudflareProvider(prompts).pipe(Effect.provide(NodeServices.layer))
    const summary = initPlanSummary({ harnesses: ["opencode", "claude"], provider }, "/private/jevvy.jsonc")

    expect(provider).toMatchObject({ provider: "cloudflare", accountId, model: "clef-flash" })
    expect(summary).toContain("experimental, uncalibrated")
    expect(summary).not.toContain("private-token")
    expect(summary).not.toContain(accountId)

    const existing = '{ "provider": "typesafe", "permissions": { "opencode": { "enabled": false } } }'
    const rendered = yield* renderJevvyConfig(existing, provider)
    expect(JSON.parse(rendered)).toMatchObject({
      provider: "cloudflare", providers: { cloudflare: { accountId, model: "clef-flash", apiKey: "private-token" } },
      permissions: { opencode: { enabled: false } },
    })
  }))
})

import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Redacted from "effect/Redacted"
import { loadJevvyConfig } from "../src/config.ts"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { vi } from "vitest"
import { createConfiguredProvider, shippedPolicyProvenance } from "../src/providers.ts"
import { DEFAULT_ZEN_MODEL, DEFAULT_TYPESAFE_MODEL, DEFAULT_OPENROUTER_MODEL, DEFAULT_VERCEL_MODEL } from "../src/core.ts"
import { createPermissionReviewer } from "../src/engine.ts"
import { createEvaluate } from "../src/opencode/evaluate.ts"
import type { EvaluationEvent } from "../src/opencode/evaluate.ts"
import { Session } from "@opencode/schema/session"
import { defaultApprovalQuestions } from "../src/questions.ts"

const presets = [
  ["zen", "OPENCODE_API_KEY", DEFAULT_ZEN_MODEL, "https://opencode.ai/zen/v1/systemone"],
  ["typesafe", "TYPESAFE_API_KEY", DEFAULT_TYPESAFE_MODEL, "https://api.typesafe.ai/v1/systemone"],
  ["openrouter", "OPENROUTER_API_KEY", DEFAULT_OPENROUTER_MODEL, "https://openrouter.ai/api/v1/systemone"],
  ["vercel", "AI_GATEWAY_API_KEY", DEFAULT_VERCEL_MODEL, "https://ai-gateway.vercel.sh/typesafe/v1/systemone"],
] as const

const customQuestions = {
  harmful: {
    type: "noul" as const,
    instructions: "Could this action cause harm?",
    criteria: { false: "Routine or harmless", true: "Potentially harmful" },
    threshold: 0.25,
  },
}

const customPolicyConfig = {
  $schema: "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  provider: "typesafe",
  permissions: { questions: customQuestions },
}

const noEnvironment = ConfigProvider.fromUnknown({})

const load = (path: string, environment = noEnvironment) => loadJevvyConfig(path, environment).pipe(Effect.provide(NodeFileSystem.layer))

const withConfigFile = <A, E, R>(
  raw: string,
  use: (path: string) => Effect.Effect<A, E, R>,
  mode?: number,
): Effect.Effect<A, E, R> => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevvy-config-"))
    const path = join(directory, "jevvy.jsonc")

    await writeFile(path, raw)

    if (mode !== undefined) await chmod(path, mode)

    return { directory, path }
  }),
  ({ path }) => use(path),
  ({ directory }) => Effect.promise(() => rm(directory, { recursive: true })),
)

describe("Jevvy configuration", () => {
  it.effect.each([undefined, "clef", "clef-flash"] as const)("loads Cloudflare model %s with file credentials before environment credentials", (model) => Effect.gen(function*() {
    for (const apiKey of [undefined, "file-token"]) {
      const environment = ConfigProvider.fromUnknown({ CLOUDFLARE_API_TOKEN: "environment-token", TYPESAFE_API_KEY: "unrelated" })

      const config = yield* withConfigFile(JSON.stringify({
        provider: "cloudflare", providers: { cloudflare: { accountId: "0123456789abcdef0123456789abcdef", model, apiKey } },
      }), (path) => load(path, environment))

      expect(config).toMatchObject({ kind: "shipped-policy", selection: { provider: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", model } })

      if (config.kind !== "shipped-policy" || config.selection.apiKey === undefined) throw new Error("Expected Cloudflare credentials")

      expect(Redacted.value(config.selection.apiKey)).toBe(apiKey ?? "environment-token")
      expect(JSON.stringify(config)).not.toContain(apiKey ?? "environment-token")
    }
  }))

  it.effect.each([
    undefined,
    {},
    { accountId: "../account" },
    { accountId: "0123456789abcdef0123456789abcdef", model: "jev" },
    { accountId: "0123456789abcdef0123456789abcdef", apiKey: "" },
    { accountId: "0123456789abcdef0123456789abcdef", opencodeCredential: "cloudflare" },
  ])("rejects incomplete or invalid Cloudflare settings: %j", (cloudflare) => Effect.gen(function*() {
    expect(yield* withConfigFile(JSON.stringify({ provider: "cloudflare", providers: { cloudflare } }), load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("uses custom Cloudflare questions and never borrows another provider's token", () => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({
      provider: "cloudflare", providers: { cloudflare: { accountId: "0123456789abcdef0123456789abcdef" } }, permissions: { questions: customQuestions },
    }), (path) => load(path, ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "unrelated-token" })))

    expect(config).toMatchObject({ kind: "custom-policy", selection: { provider: "cloudflare", apiKey: undefined }, questions: customQuestions })
  }))

  it.effect.each([undefined, false, true])("loads default-off history opt-in %s", (enabled) => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({ provider: "typesafe", metrics: { enabled } }), load)

    expect(config).toMatchObject({ kind: "shipped-policy", historyEnabled: enabled ?? false })
  }))

  it.effect("rejects the unshipped nested history shape", () => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({ provider: "typesafe", metrics: { history: { enabled: true } } }), load)
    expect(config.kind).toBe("invalid")
  }))

  it.effect.each([true, false])("rejects a boolean metrics alias %s", (metrics) => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({ provider: "typesafe", metrics }), load)
    expect(config.kind).toBe("invalid")
  }))

  it.effect.each([
    ["openai", "OPENAI_API_KEY"], ["microsoft", "AZURE_AI_API_KEY"],
  ] as const)("loads %s credentials from the file before its environment variable", ([provider, variable]) => Effect.gen(function*() {
    const fields = provider === "microsoft"
      ? { endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "my-deployment" }
      : {}

    const environment = ConfigProvider.fromUnknown({ [variable]: "environment-secret", TYPESAFE_API_KEY: "unrelated-key" })

    for (const apiKey of [undefined, "file-secret"]) {
      const settings = apiKey === undefined ? fields : { ...fields, apiKey }
      const raw = JSON.stringify({ provider, providers: { [provider]: settings } })

      const config = yield* withConfigFile(provider === "openai" && apiKey === undefined ? JSON.stringify({ provider }) : raw,
        (path) => load(path, environment))

      expect(config.kind).toBe("shipped-policy")

      if (config.kind !== "shipped-policy" || config.selection.apiKey === undefined) throw new Error("Expected configured credentials")

      expect(config.selection.provider).toBe(provider)
      expect(Redacted.value(config.selection.apiKey)).toBe(apiKey ?? "environment-secret")

      if (config.selection.provider === "microsoft") {
        expect(config.selection.model).toBe("my-deployment")
        expect(config.selection.endpoint).toBe(fields.endpoint)
      }
    }
  }))

  it.effect.each(["openai", "microsoft"] as const)("allows user-calibrated %s questions without changing shipped defaults", (provider) => Effect.gen(function*() {
    const providers = provider === "microsoft"
      ? { microsoft: { endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment" } }
      : undefined

    const config = yield* withConfigFile(JSON.stringify({ provider, providers, permissions: { questions: customQuestions } }), load)

    expect(config).toMatchObject({ kind: "custom-policy", selection: { provider }, questions: customQuestions })
  }))

  it.effect.each([
    { provider: "microsoft" },
    { provider: "microsoft", providers: { microsoft: { model: "deployment" } } },
    { provider: "microsoft", providers: { microsoft: { endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone" } } },
    { provider: "microsoft", providers: { microsoft: { endpoint: "file:///tmp/model", model: "deployment" } } },
    { provider: "microsoft", providers: { microsoft: { endpoint: "http://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment" } } },
    { provider: "microsoft", providers: { microsoft: { endpoint: "https://user:secret@foundry.example.com/providers/microsoft/v1/systemone", model: "deployment" } } },
    { provider: "microsoft", providers: { microsoft: { endpoint: "https://foundry.example.com", model: "deployment", apiKey: "" } } },
  ])("rejects incomplete or invalid Microsoft configuration: %j", (document) => Effect.gen(function*() {
    expect(yield* withConfigFile(JSON.stringify(document), load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect.each(["openai", "microsoft"] as const)("does not use another provider's credential for %s", (provider) => Effect.gen(function*() {
    const providers = provider === "microsoft"
      ? { microsoft: { endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment" } }
      : undefined

    const environment = ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "other-key" })
    const config = yield* withConfigFile(JSON.stringify({ provider, providers }), (path) => load(path, environment))

    expect(config).toMatchObject({ kind: "shipped-policy", selection: { provider, apiKey: undefined } })
  }))

  it.effect.each([
    { openai: { model: "override", apiKey: "fixture-key" } },
    { openai: { opencodeCredential: "openai", apiKey: "fixture-key" } },
    { microsoft: { endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment", opencodeCredential: "azure" } },
  ])("does not extend preset overrides or OpenCode key reuse to decision providers: %j", (providers) => Effect.gen(function*() {
    const provider = "openai" in providers ? "openai" : "microsoft"

    expect(yield* withConfigFile(JSON.stringify({ provider, providers }), load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("publishes the default-off nomination list in the consumer schema", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const schemaPath = yield* path.fromFileUrl(new URL("../../../config.schema.json", import.meta.url))
    const raw = yield* fs.readFileString(schemaPath)
    const schema = JSON.parse(raw)

    expect(schema.properties.permissions.properties.reviewAskPatterns).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        opencode: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
        claude: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
      },
    })
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect.each([undefined, {}, { reviewAskPatterns: {} }, { reviewAskPatterns: { opencode: [] } }, { reviewAskPatterns: { claude: [] } }])(
    "allocates independent host defaults on repeated loads with permissions %j",
    (permissions) => withConfigFile(JSON.stringify({ provider: "typesafe", permissions }), (path) => Effect.gen(function*() {
      const first = yield* load(path)
      const second = yield* load(path)

      if (first.kind !== "shipped-policy" || second.kind !== "shipped-policy") throw new Error("Expected shipped policy")
      expect(first.reviewAskPatterns).toEqual({ opencode: [], claude: [] })
      expect(first.reviewAskPatterns.opencode).not.toBe(first.reviewAskPatterns.claude)
      expect(second.reviewAskPatterns.opencode).not.toBe(second.reviewAskPatterns.claude)
      expect(first.reviewAskPatterns.opencode).not.toBe(second.reviewAskPatterns.opencode)
      expect(first.reviewAskPatterns.claude).not.toBe(second.reviewAskPatterns.claude)
    })),
  )

  it.effect.each([undefined, {}, { opencode: ["*"] }, { claude: ["Bash(echo *)"] }])("normalizes nominations for calibrated Laya policies %j", (reviewAskPatterns) => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({
      provider: "laya",
      providers: { laya: { policy: { checkpoint: "english", questions: customQuestions } } },
      permissions: { reviewAskPatterns },
    }), load)

    expect(config).toMatchObject({
      kind: "custom-policy",
      reviewAskPatterns: { opencode: reviewAskPatterns?.opencode ?? [], claude: reviewAskPatterns?.claude ?? [] },
    })
  }))

  it.effect.each([undefined, {}, { opencode: [] }, { claude: [] }, { opencode: ["*"] }, { claude: ["Bash(git *)"] }, { opencode: ["npm run *", "git *"], claude: ["*", "*"] }])("loads review ask nominations %j for shipped and custom policies", (reviewAskPatterns) => Effect.gen(function*() {
    for (const questions of [undefined, customQuestions]) {
      const raw = JSON.stringify({ provider: "typesafe", permissions: { reviewAskPatterns, questions } })

      expect(yield* withConfigFile(raw, load)).toMatchObject({
        kind: questions === undefined ? "shipped-policy" : "custom-policy",
        reviewAskPatterns: { opencode: reviewAskPatterns?.opencode ?? [], claude: reviewAskPatterns?.claude ?? [] },
      })
    }
  }))

  it.effect.each([null, "*", [], ["*"], { opencode: null }, { claude: "*" }, { opencode: [""] }, { claude: [true] }, { opencode: [1] }, { other: [] }])("rejects malformed review ask nominations %j", (reviewAskPatterns) => Effect.gen(function*() {
    const raw = JSON.stringify({ provider: "typesafe", permissions: { reviewAskPatterns } })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect.each([null, [], "permissions"])("does not default a malformed permissions object %j", (permissions) => Effect.gen(function*() {
    expect(yield* withConfigFile(JSON.stringify({ provider: "typesafe", permissions }), load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("preserves nomination spelling without normalization", () => Effect.gen(function*() {
    const reviewAskPatterns = { opencode: ["**", "GIT *", "tools\\*", "git * "], claude: ["Bash(git *)", "Bash(git:*)", " Bash(git *) "] }
    const raw = JSON.stringify({ provider: "typesafe", permissions: { reviewAskPatterns } })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "shipped-policy", reviewAskPatterns })
  }))

  it.effect.each([
    { gateAskPatterns: ["*"] },
    { opencode: { reviewAskPatterns: ["*"] } },
    { claude: { reviewAskPatterns: ["Bash(git *)"] } },
  ])("rejects alternate nomination configuration %j", (permissions) => Effect.gen(function*() {
    expect(yield* withConfigFile(JSON.stringify({ provider: "typesafe", permissions }), load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect.each(presets)("sends the exact configured %s model through the real client", ([provider, variable, defaultModel, endpoint]) => Effect.gen(function*() {
    for (const model of [undefined, defaultModel, "jev-1.13", "jev-1.13-free", "typesafe/jev-test-arbitrary", " unmodified "]) {
      const config = yield* withConfigFile(JSON.stringify({ provider, providers: { [provider]: { model } } }),
        (path) => load(path, ConfigProvider.fromUnknown({ [variable]: "environment-key" })))

      expect(config.kind).toBe("shipped-policy")

      if (config.kind !== "shipped-policy") throw new Error("Expected shipped policy")
      expect(config.timeoutMs).toBe(5_000)
      const selected = createConfiguredProvider(config.selection)

      if (selected === undefined) throw new Error("Expected selected provider")

      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
        model: "reported-model", answers: { routine: { type: "noul", noul: 0.1 } },
      }))

      const input = { state: { command: "pwd && ls > listing" }, questions: { routine: { type: "noul" as const, instructions: "Is this routine?" } } }
      const result = yield* selected.client.evaluate(input).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))
      expect(result.model).toBe("reported-model")
      expect(selected.requestedModel).toBe(model ?? defaultModel)
      expect(selected.expectedModel).toBe(model ?? defaultModel)
      const calibratedModel = provider === "zen" ? "jev-1.13-free" : defaultModel
      expect(shippedPolicyProvenance(selected)).toBe((model ?? defaultModel) === calibratedModel ? "calibrated-defaults" : "shipped-defaults-unverified")
      expect(transport).toHaveBeenCalledOnce()
      const [url, init] = transport.mock.calls[0] ?? []

      if (!(url instanceof URL)) throw new Error("Expected request URL")
      expect(url.href).toBe(endpoint)
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer environment-key")
      expect(headers.has("x-api-key")).toBe(false)
      expect(init?.body).toBeInstanceOf(Uint8Array)

      if (!(init?.body instanceof Uint8Array)) throw new Error("Expected request bytes")
      expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({ ...input, model: model ?? defaultModel })
    }
  }))

  it.effect.each(presets)("validates %s scoped settings and credential precedence", ([provider, variable]) => Effect.gen(function*() {
    for (const model of ["", null, 3, [], {}]) {
      expect(yield* withConfigFile(JSON.stringify({ provider, providers: { [provider]: { model } } }), load)).toMatchObject({ kind: "invalid" })
    }

    const raw = JSON.stringify({ provider, providers: { [provider]: { model: "jev-1.13", apiKey: "file-key" } } })
    const config = yield* withConfigFile(raw, (path) => load(path, ConfigProvider.fromUnknown({ [variable]: "env-key" })))

    if (config.kind !== "shipped-policy" || config.selection.apiKey === undefined) throw new Error("Expected file key")
    expect(Redacted.value(config.selection.apiKey)).toBe("file-key")
    const selected = createConfiguredProvider(config.selection)

    if (selected === undefined) throw new Error("Expected selected provider")
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "reported", answers: { routine: { type: "noul", noul: 0 } } }))
    yield* selected.client.evaluate({ state: {}, questions: { routine: { type: "noul", instructions: "Routine?" } } }).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))
    const [, init] = transport.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer file-key")
    const missing = yield* withConfigFile(JSON.stringify({ provider, providers: { [provider]: { model: "override" } } }), load)

    if (missing.kind !== "shipped-policy") throw new Error("Expected shipped policy")
    expect(createConfiguredProvider(missing.selection)).toBeUndefined()
  }))

  it.effect("does not secure a model-only file as credential-bearing", () => withConfigFile(
    JSON.stringify({ provider: "zen", providers: { zen: { model: "jev-1.13" } } }),
    (path) => Effect.gen(function*() {
      expect((yield* load(path)).kind).toBe("shipped-policy")

      if (process.platform !== "win32") expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o644)
    }), 0o644,
  ))

  it.effect.each(presets)("abstains without fallback on %s override failures", ([provider, variable]) => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({ provider, providers: { [provider]: { model: "unsupported-route" } } }),
      (path) => load(path, ConfigProvider.fromUnknown({ [variable]: "test-key" })))

    if (config.kind !== "shipped-policy") throw new Error("Expected shipped policy")
    const selected = createConfiguredProvider(config.selection)

    if (selected === undefined) throw new Error("Expected selected provider")

    const success = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "distinct-reported-model", answers: Object.fromEntries(
      Object.keys(defaultApprovalQuestions).map((key) => [key, { type: "noul", noul: 0 }]),
    ) }))

    const successfulReviewer = yield* createPermissionReviewer(selected.client)
    const review = yield* successfulReviewer.review({ action: "shell", resources: ["pwd"] }).pipe(Effect.provideService(FetchHttpClient.Fetch, success))
    expect(review).toMatchObject({ effect: "allow", judgments: [{ model: "distinct-reported-model" }] })
    expect(success).toHaveBeenCalledOnce()

    for (const failure of ["unsupported", "malformed", "transport"] as const) {
      const transport = vi.fn<typeof fetch>()

      if (failure === "transport") transport.mockRejectedValue(new Error("offline"))
      else transport.mockResolvedValue(failure === "unsupported" ? Response.json({ error: "unsupported model" }, { status: 404 }) : Response.json({ model: "reported-model", answers: {} }))
      const reviewer = yield* createPermissionReviewer(selected.client)
      const report = vi.fn()
      const evaluate = createEvaluate(reviewer, { inspect: () => Effect.succeed({ command: "pwd", explicitAsk: false }), report })
      const event: EvaluationEvent = { sessionID: Session.ID.make("ses_test"), action: "shell", resources: ["pwd"], effect: "ask", message: "Host approval" }
      yield* evaluate(event).pipe(Effect.provideService(FetchHttpClient.Fetch, transport))
      expect(event).toMatchObject({ effect: "ask", message: "Host approval" })
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ effect: "ask", reason: "unavailable" }))
      expect(transport).toHaveBeenCalledOnce()
      const [, init] = transport.mock.calls[0] ?? []

      if (!(init?.body instanceof Uint8Array)) throw new Error("Expected request bytes")
      expect(JSON.parse(new TextDecoder().decode(init.body)).model).toBe("unsupported-route")
    }
  }))

  it.effect("keeps custom questions custom with a model override", () => Effect.gen(function*() {
    const raw = JSON.stringify({ provider: "zen", providers: { zen: { model: "jev-1.13" } }, permissions: { questions: customQuestions } })
    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "custom-policy", questions: customQuestions, selection: { model: "jev-1.13" } })
  }))

  it.effect.each([
    { provider: "laya", providers: { laya: { model: "arbitrary" } } },
    { provider: "custom", providers: { custom: { model: "arbitrary" } } },
    { provider: "zen", providers: { zen: { model: "arbitrary", endpoint: "https://example.com" } } },
  ])("keeps endpoint and other provider boundaries intact: %j", (document) => Effect.gen(function*() {
    expect(yield* withConfigFile(JSON.stringify(document), load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("loads an OpenCode credential integration id", () => Effect.gen(function*() {
    const raw = JSON.stringify({ provider: "openrouter", providers: { openrouter: { opencodeCredential: "openrouter" } } })

    expect(yield* withConfigFile(raw, load)).toMatchObject({
      kind: "shipped-policy",
      selection: { provider: "openrouter", opencodeCredential: "openrouter" },
    })

    const empty = JSON.stringify({ provider: "openrouter", providers: { openrouter: { opencodeCredential: "" } } })

    expect(yield* withConfigFile(empty, load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect.each([undefined, 12_000, 0.5])("loads timeoutMs %s for shipped and custom policies", (timeoutMs) => Effect.gen(function*() {
    for (const questions of [undefined, customQuestions]) {
      const raw = JSON.stringify({ provider: "typesafe", providers: { typesafe: { model: "configured-route" } }, permissions: { timeoutMs, questions } })

      expect(yield* withConfigFile(raw, load)).toMatchObject({
        kind: questions === undefined ? "shipped-policy" : "custom-policy",
        timeoutMs: timeoutMs ?? 5_000,
        selection: { provider: "typesafe", model: "configured-route" },
      })
    }
  }))

  it.effect.each(["0", "-1", "null", '"12000"', "true", "1e999"])(
    "rejects invalid timeoutMs %s",
    (timeoutMs) => Effect.gen(function*() {
      const raw = `{"provider":"typesafe","permissions":{"timeoutMs":${timeoutMs}}}`

      expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
    }),
  )

  it.effect("loads a complete custom question set", () => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify(customPolicyConfig), load)

    expect(config).toEqual({
      kind: "custom-policy",
      historyEnabled: false,
      reviewAskPatterns: { opencode: [], claude: [] },
      timeoutMs: 5_000,
      selection: { provider: "typesafe", apiKey: undefined },
      questions: customQuestions,
    })
  }))

  it.effect.each([
    "not json",
    JSON.stringify({}),
    JSON.stringify({ provider: "auto" }),
    JSON.stringify({ provider: "other" }),
    JSON.stringify({ ...customPolicyConfig, unknown: true }),
    JSON.stringify({ provider: "typesafe", permissions: { questions: {} } }),
    JSON.stringify({
      provider: "typesafe",
      permissions: { questions: { "": customQuestions.harmful } },
    }),
    JSON.stringify({
      provider: "typesafe",
      permissions: {
        questions: {
          harmful: {
            type: "noul",
            instructions: "Could this cause harm?",
            threshold: 2,
          },
        },
      },
    }),
    JSON.stringify({
      provider: "typesafe",
      permissions: {
        questions: {
          harmful: { type: "noul", instructions: "Could this cause harm?" },
        },
      },
    }),
    JSON.stringify({
      provider: "custom",
      providers: { custom: { endpoint: "file:///tmp/laya", model: "laya" } },
      permissions: { questions: customQuestions },
    }),
  ])("rejects invalid explicit configuration", (raw) => Effect.gen(function*() {
    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("stays unconfigured when the global file is absent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "jevvy-config-"))),
      (directory) => Effect.gen(function*() {
        expect(yield* load(join(directory, "missing.json"))).toEqual({ kind: "unconfigured" })
      }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true })),
    ))

  it.effect("loads the explicitly selected provider and prefers its global key", () => Effect.gen(function*() {
    const environment = ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "environment-key" })

    const raw = JSON.stringify({
      provider: "typesafe",
      providers: { typesafe: { apiKey: "file-key" } },
    })

    const config = yield* withConfigFile(raw, (path) => load(path, environment), 0o600)

    expect(config.kind).toBe("shipped-policy")

    if (config.kind !== "shipped-policy") return

    expect(config.selection.provider).toBe("typesafe")
    expect(config.selection.apiKey).toBeDefined()

    if (config.selection.apiKey === undefined) return

    expect(Redacted.value(config.selection.apiKey)).toBe("file-key")
  }))

  it.effect("uses the selected provider's native environment key when the global file has none", () =>
    Effect.gen(function*() {
      const environment = ConfigProvider.fromUnknown({ OPENROUTER_API_KEY: "environment-key" })
      const raw = JSON.stringify({ provider: "openrouter" })
      const config = yield* withConfigFile(raw, (path) => load(path, environment))

      expect(config.kind).toBe("shipped-policy")

      if (config.kind !== "shipped-policy") return

      expect(config.selection.provider).toBe("openrouter")
      expect(config.selection.apiKey).toBeDefined()

      if (config.selection.apiKey === undefined) return

      expect(Redacted.value(config.selection.apiKey)).toBe("environment-key")
    }))

  it.effect("loads an unauthenticated custom System One endpoint with custom questions", () =>
    Effect.gen(function*() {
      const raw = JSON.stringify({
        provider: "custom",
        providers: {
          custom: {
            endpoint: "http://127.0.0.1:8080/v1/decisions",
            model: "laya-typed-decisions",
          },
        },
        permissions: { questions: customQuestions },
      })

      expect(yield* withConfigFile(raw, load)).toEqual({
        kind: "custom-policy",
        historyEnabled: false,
        reviewAskPatterns: { opencode: [], claude: [] },
        timeoutMs: 5_000,
        selection: {
          provider: "custom",
          endpoint: "http://127.0.0.1:8080/v1/decisions",
          model: "laya-typed-decisions",
          apiKey: undefined,
        },
        questions: customQuestions,
      })
    }))

  it.effect("requires an explicit permission policy for Laya", () => Effect.gen(function*() {
    const config = yield* withConfigFile(JSON.stringify({ provider: "laya" }), load)

    expect(config).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("Laya requires providers.laya.policy"),
    })
  }))

  it.effect("loads a local Laya server with an explicit policy and no credential", () => Effect.gen(function*() {
    const raw = JSON.stringify({
      provider: "laya",
      providers: { laya: { policy: { checkpoint: "english", questions: customQuestions } } },
      permissions: { timeoutMs: 12_000, reviewAskPatterns: { opencode: ["*"], claude: ["Bash(git *)"] } },
    })

    expect(yield* withConfigFile(raw, load)).toEqual({
      kind: "custom-policy",
      historyEnabled: false,
      reviewAskPatterns: { opencode: ["*"], claude: ["Bash(git *)"] },
      timeoutMs: 12_000,
      selection: { provider: "laya", endpoint: undefined, model: undefined, apiKey: undefined },
      questions: customQuestions,
    })
  }))

  it.effect("loads a Laya endpoint, checkpoint, and optional environment key", () => Effect.gen(function*() {
    const raw = JSON.stringify({
      provider: "laya",
      providers: { laya: {
        endpoint: "http://127.0.0.1:18871/v1/systemone",
        model: "multilingual",
        policy: { checkpoint: "multilingual", questions: customQuestions },
      } },
    })

    const environment = ConfigProvider.fromUnknown({ LAYA_API_KEY: "local-secret" })
    const config = yield* withConfigFile(raw, (path) => load(path, environment))

    expect(config.kind).toBe("custom-policy")

    if (config.kind !== "custom-policy" || config.selection.provider !== "laya") return

    expect(config.selection.endpoint).toBe("http://127.0.0.1:18871/v1/systemone")
    expect(config.selection.model).toBe("multilingual")
    expect(config.selection.apiKey === undefined ? undefined : Redacted.value(config.selection.apiKey)).toBe("local-secret")
  }))

  it.effect.each(["file:///tmp/laya", "ftp://example.com/systemone"])(
    "rejects a non-HTTP Laya endpoint: %s",
    (endpoint) => Effect.gen(function*() {
      const raw = JSON.stringify({
        provider: "laya",
        providers: { laya: { endpoint, policy: { checkpoint: "english", questions: customQuestions } } },
      })

      expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
    }),
  )

  it.effect.each([
    { providers: { laya: { model: "jev-1.13.0", policy: { checkpoint: "english", questions: customQuestions } } } },
    { providers: { laya: { policy: { checkpoint: "english", questions: { harmful: { type: "noul", instructions: "Risk?", threshold: 2 } } } } } },
    { providers: { laya: { policy: { checkpoint: "english", questions: { harmful: { type: "choice", instructions: "Risk?", threshold: 0.2 } } } } } },
  ])("rejects a malformed manually configured Laya model or policy", (fields) => Effect.gen(function*() {
    const raw = JSON.stringify({ provider: "laya", ...fields })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("does not accept top-level questions as a Laya policy", () => Effect.gen(function*() {
    const raw = JSON.stringify({ provider: "laya", permissions: { questions: customQuestions } })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid", message: expect.stringContaining("providers.laya.policy") })
  }))

  it.effect("rejects top-level questions even when a Laya policy exists", () => Effect.gen(function*() {
    const raw = JSON.stringify({
      provider: "laya",
      providers: { laya: { policy: { checkpoint: "english", questions: customQuestions } } },
      permissions: { questions: customQuestions },
    })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid" })
  }))

  it.effect("rejects a Laya policy after the selected checkpoint changes", () => Effect.gen(function*() {
    const raw = JSON.stringify({
      provider: "laya",
      providers: { laya: { model: "multilingual", policy: { checkpoint: "english", questions: customQuestions } } },
    })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "invalid", message: expect.stringContaining("matching checkpoint") })
  }))

  it.effect("does not apply a nested Laya policy to another provider", () => Effect.gen(function*() {
    const raw = JSON.stringify({
      provider: "typesafe",
      providers: { laya: { policy: { checkpoint: "english", questions: customQuestions } } },
    })

    expect(yield* withConfigFile(raw, load)).toMatchObject({ kind: "shipped-policy", selection: { provider: "typesafe" } })
  }))

  it.effect("uses shipped questions when a custom provider does not configure questions", () =>
    Effect.gen(function*() {
      const raw = JSON.stringify({
        provider: "custom",
        providers: {
          custom: { endpoint: "https://api.aimlapi.com/v1/decisions", model: "typesafe/jev" },
        },
      })

      expect(yield* withConfigFile(raw, load)).toEqual({
        kind: "shipped-policy",
        historyEnabled: false,
        reviewAskPatterns: { opencode: [], claude: [] },
        timeoutMs: 5_000,
        selection: {
          provider: "custom",
          endpoint: "https://api.aimlapi.com/v1/decisions",
          model: "typesafe/jev",
          apiKey: undefined,
        },
      })
    }))

  it.effect("accepts comments and trailing commas", () => Effect.gen(function*() {
    const raw = `{
      // Select one provider explicitly.
      "provider": "typesafe",
    }`

    expect(yield* withConfigFile(raw, load)).toEqual({
      kind: "shipped-policy",
      historyEnabled: false,
      reviewAskPatterns: { opencode: [], claude: [] },
      timeoutMs: 5_000,
      selection: { provider: "typesafe", apiKey: undefined },
    })
  }))

  it.effect.each([0o644, 0o400])("secures a credential file with mode %s", (mode) => {
    if (process.platform === "win32") return Effect.void

    const raw = JSON.stringify({ provider: "zen", providers: { zen: { apiKey: "file-key" } } })

    return withConfigFile(raw, (path) => Effect.gen(function*() {
      const config = yield* load(path)
      const info = yield* Effect.promise(() => stat(path))

      expect(config.kind).toBe("shipped-policy")
      expect(info.mode & 0o777).toBe(0o600)
    }), mode)
  })

  it.effect.each(["openai", "microsoft"] as const)("secures stored %s credentials", (provider) => {
    if (process.platform === "win32") return Effect.void

    const settings = provider === "microsoft"
      ? { endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "deployment", apiKey: "file-key" }
      : { apiKey: "file-key" }

    const raw = JSON.stringify({ provider, providers: { [provider]: settings } })

    return withConfigFile(raw, (path) => Effect.gen(function*() {
      const config = yield* load(path)
      const info = yield* Effect.promise(() => stat(path))

      expect(config.kind).toBe("shipped-policy")
      expect(info.mode & 0o777).toBe(0o600)
    }), 0o644)
  })
})

import { describe, expect, it, vi } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Terminal from "effect/Terminal"
import type * as Prompt from "effect/cli/Prompt"
import { endpointError, layaEndpointError, layaPromptDefaults, promptLayaProvider } from "../src/init/prompt.ts"

describe("Laya init prompts", () => {
  it.effect("offers local defaults without asking for an API key", () => Effect.gen(function*() {
    const prompts = {
      text: vi.fn(() => Effect.succeed("http://127.0.0.1:8000/v1/systemone")),
      select: vi.fn(() => Effect.succeed("english" as const)),
      confirm: vi.fn(() => Effect.succeed(false)),
      password: vi.fn(() => Effect.succeed(Redacted.make("unused"))),
    }

    const provider = yield* promptLayaProvider(prompts).pipe(Effect.provide(NodeServices.layer))

    expect(prompts.text).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Laya System One URL"), default: "http://127.0.0.1:8000/v1/systemone",
    }))
    expect(prompts.select).toHaveBeenCalledWith(expect.objectContaining({
      message: "Laya checkpoint", choices: expect.arrayContaining([{ value: "english", title: "English" }]),
    }))
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initial: false }))
    expect(prompts.password).not.toHaveBeenCalled()
    expect(provider).toEqual({ provider: "laya" })
  }))

  it.effect("keeps server, checkpoint, and optional Bearer key overrides", () => Effect.gen(function*() {
    const prompts = {
      text: vi.fn(() => Effect.succeed("http://127.0.0.1:18871/v1/systemone")),
      select: vi.fn(() => Effect.succeed("multilingual" as const)),
      confirm: vi.fn(() => Effect.succeed(true)),
      password: vi.fn(() => Effect.succeed(Redacted.make("local-secret"))),
    }

    const provider = yield* promptLayaProvider(prompts).pipe(Effect.provide(NodeServices.layer))

    expect(provider).toMatchObject({ provider: "laya", endpoint: "http://127.0.0.1:18871/v1/systemone", model: "multilingual" })

    if (provider.apiKey === undefined) throw new Error("Expected a Laya key")
    expect(Redacted.value(provider.apiKey)).toBe("local-secret")
    expect(JSON.stringify(provider)).not.toContain("local-secret")
    expect(prompts.password).toHaveBeenCalledWith(expect.objectContaining({ message: "Enter the Laya API key" }))
  }))

  it.effect("prefills saved settings without exposing the old key and puts the saved checkpoint first", () => Effect.gen(function*() {
    const defaults = layaPromptDefaults(`{
      "provider": "openrouter",
      "providers": { "laya": {
        "endpoint": "https://laya.example.com/v1/systemone",
        "model": "typed-decisions", "apiKey": "old-secret",
      } },
    }`)

    const prompts = {
      text: vi.fn(() => Effect.succeed("https://laya.example.com/v1/systemone")),
      select: vi.fn((_options: Prompt.SelectOptions<"english" | "multilingual" | "typed-decisions">) => Effect.succeed("typed-decisions" as const)),
      confirm: vi.fn(() => Effect.succeed(true)),
      password: vi.fn(() => Effect.succeed(Redacted.make("new-secret"))),
    }

    expect(defaults).toEqual({ endpoint: "https://laya.example.com/v1/systemone", model: "typed-decisions", hasApiKey: true })
    expect(JSON.stringify(defaults)).not.toContain("old-secret")
    expect(yield* promptLayaProvider(prompts, defaults).pipe(Effect.provide(NodeServices.layer))).toMatchObject({
      provider: "laya", endpoint: "https://laya.example.com/v1/systemone", model: "typed-decisions",
    })
    expect(prompts.text).toHaveBeenCalledWith(expect.objectContaining({ default: "https://laya.example.com/v1/systemone" }))
    const choices = prompts.select.mock.calls[0]?.[0].choices
    expect(choices?.[0]?.value).toBe("typed-decisions")
    expect(choices).toHaveLength(3)
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initial: true }))
    expect(prompts.password).toHaveBeenCalledOnce()
  }))

  it.each([
    ["not JSONC", {}],
    ['{ "provider": "laya" }', {}],
    [JSON.stringify({ providers: { laya: { endpoint: "file:///tmp/laya", apiKey: "" } } }), {
      endpoint: undefined, model: undefined, hasApiKey: false,
    }],
    [JSON.stringify({ providers: { laya: { model: "unknown" } } }), {}],
  ])("does not prefill invalid or absent Laya settings", (raw, expected) => {
    expect(layaPromptDefaults(raw)).toEqual(expected)
  })

  it.effect("does not display private URL parameters when prefilling an existing server", () => Effect.gen(function*() {
    const defaults = layaPromptDefaults(JSON.stringify({
      providers: { laya: { endpoint: "https://laya.example.com/v1/systemone?token=private-key" } },
    }))

    const prompts = {
      text: vi.fn(() => Effect.succeed("http://127.0.0.1:8000/v1/systemone")),
      select: vi.fn(() => Effect.succeed("english" as const)),
      confirm: vi.fn(() => Effect.succeed(false)),
      password: vi.fn(() => Effect.succeed(Redacted.make("unused"))),
    }

    expect(defaults).toMatchObject({ urlNeedsReentry: true, endpoint: undefined })
    expect(JSON.stringify(defaults)).not.toContain("private-key")
    yield* promptLayaProvider(prompts, defaults).pipe(Effect.provide(NodeServices.layer))
    expect(prompts.text).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("re-enter URL with private parameters"), default: "http://127.0.0.1:8000/v1/systemone",
    }))
  }))

  for (const stage of ["text", "select", "confirm", "password"] as const) {
    it.effect(`stops after cancelling the ${stage} prompt`, () => Effect.gen(function*() {
      const prompts = {
        text: vi.fn((): Effect.Effect<string, Terminal.QuitError> => Effect.succeed("http://127.0.0.1:8000/v1/systemone")),
        select: vi.fn((): Effect.Effect<"english", Terminal.QuitError> => Effect.succeed("english")),
        confirm: vi.fn((): Effect.Effect<boolean, Terminal.QuitError> => Effect.succeed(true)),
        password: vi.fn((): Effect.Effect<Redacted.Redacted<string>, Terminal.QuitError> => Effect.succeed(Redacted.make("local-secret"))),
      }

      const stages = ["text", "select", "confirm", "password"] as const
      prompts[stage].mockReturnValueOnce(Effect.fail(new Terminal.QuitError()))
      const error = yield* promptLayaProvider(prompts).pipe(Effect.provide(NodeServices.layer), Effect.flip)

      expect(error._tag).toBe("QuitError")

      for (const later of stages.slice(stages.indexOf(stage) + 1)) expect(prompts[later]).not.toHaveBeenCalled()
    }))
  }

  it.each([
    ["", "This value is required"],
    ["not a URL", "Enter a valid endpoint URL"],
    ["ftp://example.com/v1/systemone", "Use an http:// or https:// endpoint"],
    ["file:///tmp/systemone", "Use an http:// or https:// endpoint"],
  ])("rejects invalid endpoint %s", (endpoint, error) => {
    expect(layaEndpointError(endpoint)).toBe(error)
  })

  it("keeps custom URL validation compatible while rejecting URL credentials for Laya", () => {
    const endpoint = "https://name:secret@example.com/v1/systemone"
    expect(endpointError(endpoint)).toBeUndefined()
    expect(layaEndpointError(endpoint)).toBe("Use a Bearer API key instead of URL credentials")
  })

  it.each(["http://127.0.0.1:8000/v1/systemone", "https://example.com/v1/systemone"])("accepts HTTP endpoint %s", (endpoint) => {
    expect(endpointError(endpoint)).toBeUndefined()
  })
})

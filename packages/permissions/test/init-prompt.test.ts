import { CANCEL_SYMBOL } from "@clack/prompts"
import { describe, expect, it, vi } from "vitest"
import { Redacted } from "effect"
import { endpointError, layaEndpointError, layaPromptDefaults, promptLayaProvider } from "../src/init/prompt.ts"

describe("Laya init prompts", () => {
  it("offers local defaults without asking for an API key", async () => {
    const prompts = {
      text: vi.fn(async () => "http://127.0.0.1:8000/v1/systemone"),
      select: vi.fn(async () => "english" as const),
      confirm: vi.fn(async () => false),
      password: vi.fn(async () => "unused"),
    }

    const provider = await promptLayaProvider(prompts)

    expect(prompts.text).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Laya System One URL"),
      initialValue: "http://127.0.0.1:8000/v1/systemone",
    }))
    expect(prompts.select).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Laya checkpoint"),
      initialValue: "english",
    }))
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Does your Laya server require a Bearer API key?"),
      initialValue: false,
    }))
    expect(prompts.password).not.toHaveBeenCalled()
    expect(provider).toEqual({ provider: "laya" })
  })

  it("keeps server, checkpoint, and optional Bearer key overrides", async () => {
    const prompts = {
      text: vi.fn(async () => "http://127.0.0.1:18871/v1/systemone"),
      select: vi.fn(async () => "multilingual" as const),
      confirm: vi.fn(async () => true),
      password: vi.fn(async () => "local-secret"),
    }

    const provider = await promptLayaProvider(prompts)

    expect(provider).toMatchObject({
      provider: "laya",
      endpoint: "http://127.0.0.1:18871/v1/systemone",
      model: "multilingual",
    })

    if (provider?.apiKey === undefined) throw new Error("Expected a Laya key")

    expect(Redacted.value(provider.apiKey)).toBe("local-secret")
    expect(prompts.password).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Enter the Laya API key"),
    }))
  })

  it("prefills saved non-default Laya settings without exposing the old key", async () => {
    const defaults = layaPromptDefaults(`{
      "provider": "openrouter",
      "providers": {
        "laya": {
          "endpoint": "https://laya.example.com/v1/systemone",
          "model": "typed-decisions",
          "apiKey": "old-secret",
        },
      },
    }`)

    const prompts = {
      text: vi.fn(async () => "https://laya.example.com/v1/systemone"),
      select: vi.fn(async () => "typed-decisions" as const),
      confirm: vi.fn(async () => true),
      password: vi.fn(async () => "new-secret"),
    }

    expect(defaults).toEqual({
      endpoint: "https://laya.example.com/v1/systemone",
      model: "typed-decisions",
      hasApiKey: true,
    })
    expect(JSON.stringify(defaults)).not.toContain("old-secret")
    expect(await promptLayaProvider(prompts, defaults)).toMatchObject({
      provider: "laya",
      endpoint: "https://laya.example.com/v1/systemone",
      model: "typed-decisions",
    })
    expect(prompts.text).toHaveBeenCalledWith(expect.objectContaining({
      initialValue: "https://laya.example.com/v1/systemone",
    }))
    expect(prompts.select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "typed-decisions" }))
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }))
    expect(prompts.password).toHaveBeenCalledOnce()
  })

  it.each([
    ["not JSONC", {}],
    ['{ "provider": "laya" }', {}],
    [JSON.stringify({ providers: { laya: { endpoint: "file:///tmp/laya", apiKey: "" } } }), {
      endpoint: undefined,
      model: undefined,
      hasApiKey: false,
    }],
    [JSON.stringify({ providers: { laya: { model: "unknown" } } }), {}],
  ])("does not prefill invalid or absent Laya settings", (raw, expected) => {
    expect(layaPromptDefaults(raw)).toEqual(expected)
  })

  it("does not display private URL parameters when prefilling an existing Laya server", async () => {
    const defaults = layaPromptDefaults(JSON.stringify({
      providers: { laya: { endpoint: "https://laya.example.com/v1/systemone?token=private-key" } },
    }))

    const prompts = {
      text: vi.fn(async () => "http://127.0.0.1:8000/v1/systemone"),
      select: vi.fn(async () => "english" as const),
      confirm: vi.fn(async () => false),
      password: vi.fn(async () => "unused"),
    }

    expect(defaults).toMatchObject({ urlNeedsReentry: true, endpoint: undefined })
    expect(JSON.stringify(defaults)).not.toContain("private-key")
    await promptLayaProvider(prompts, defaults)
    expect(prompts.text).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("re-enter URL with private parameters"),
      initialValue: "http://127.0.0.1:8000/v1/systemone",
    }))
  })

  it.each(["text", "select", "confirm", "password"] as const)("stops after cancelling the %s prompt", async (stage) => {
    const prompts = {
      text: vi.fn(async (): Promise<string | typeof CANCEL_SYMBOL> => "http://127.0.0.1:8000/v1/systemone"),
      select: vi.fn(async (): Promise<"english" | typeof CANCEL_SYMBOL> => "english"),
      confirm: vi.fn(async (): Promise<boolean | typeof CANCEL_SYMBOL> => true),
      password: vi.fn(async (): Promise<string | typeof CANCEL_SYMBOL> => "local-secret"),
    }

    const stages = ["text", "select", "confirm", "password"] as const

    prompts[stage].mockResolvedValueOnce(CANCEL_SYMBOL)

    expect(await promptLayaProvider(prompts)).toBeUndefined()

    for (const later of stages.slice(stages.indexOf(stage) + 1)) {
      expect(prompts[later]).not.toHaveBeenCalled()
    }
  })

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

  it.each(["http://127.0.0.1:8000/v1/systemone", "https://example.com/v1/systemone"])(
    "accepts HTTP endpoint %s",
    (endpoint) => {
      expect(endpointError(endpoint)).toBeUndefined()
    },
  )
})

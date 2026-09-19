import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createJudge, modelAvailable } from "../../src/core/judge.ts"
import { contextQuestions, riskQuestions } from "../../src/core/questions.ts"

const responseBody = {
  model: "jev-1.13.0",
  answers: {
    destructive: { type: "noul", noul: 0.11 },
    sensitive: { type: "noul", noul: 0.22 },
    executes: { type: "noul", noul: 0.33 },
    network: { type: "noul", noul: 0.44 },
    obfuscated: { type: "noul", noul: 0.55 },
    authorized: { type: "noul", noul: 0.88 },
    off_task: { type: "noul", noul: 0.07 },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
}

afterEach(() => vi.restoreAllMocks())

describe("TypeSafe judge runtime", () => {
  it("converts System One data across a Promise-only seam", async () => {
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(responseBody))
    const judge = createJudge("test-key")

    try {
      const pending = judge.judge({ command: "npm install", cwd: "jevvy", task: "x".repeat(1_500) })

      expect(pending).toBeInstanceOf(Promise)
      expect(Effect.isEffect(pending)).toBe(false)

      const judged = await pending

      expect(Effect.isEffect(judged)).toBe(false)
      expect(Object.getPrototypeOf(judged)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(judged.risk)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(judged.context)).toBe(Object.prototype)
      expect(judged).toEqual({
        risk: {
          destructive: 0.11,
          sensitive: 0.22,
          executes: 0.33,
          network: 0.44,
          obfuscated: 0.55,
        },
        context: { authorized: 0.88, off_task: 0.07 },
        model: "jev-1.13.0",
      })

      const [url, init] = transport.mock.calls[0] ?? []
      const body = JSON.parse(String(init?.body))

      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone")
      expect(init?.headers).toEqual(expect.objectContaining({
        accept: "application/json",
        authorization: "Bearer test-key",
        "content-type": "application/json",
      }))
      expect(body.state).toEqual({ command: "npm install", cwd: "jevvy", task: "x".repeat(1_200) })
      expect(body.questions).toEqual({ ...riskQuestions, ...contextQuestions })
    } finally {
      await judge.dispose?.()
    }
  })

  it("interrupts the rc.116 transport from the caller AbortSignal", async () => {
    let markStarted: (signal: AbortSignal) => void = () => undefined
    let markAborted: () => void = () => undefined

    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve
    })

    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })

    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal

      if (!(signal instanceof AbortSignal)) return Promise.reject(new Error("missing transport signal"))

      markStarted(signal)

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          markAborted()
          reject(signal.reason)
        }, { once: true })
      })
    })

    const judge = createJudge("test-key")
    const controller = new AbortController()
    const reason = new DOMException("cancelled by test", "AbortError")

    try {
      const pending = judge.judge({ command: "npm install" }, controller.signal)

      const rejection = pending.then(
        () => new Error("judge unexpectedly completed"),
        (error) => error,
      )

      const transportSignal = await started

      expect(transportSignal).not.toBe(controller.signal)
      expect(transportSignal.aborted).toBe(false)

      controller.abort(reason)

      await aborted
      expect(await rejection).toBe(reason)
      expect(transportSignal.aborted).toBe(true)
    } finally {
      await judge.dispose?.()
    }
  })

  it("probes the pinned model with a noul System One request", async () => {
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      model: "jev-1.13.0",
      answers: { ready: { type: "noul", noul: 1 } },
    }))

    await expect(modelAvailable("test-key", "jev-1.13.0")).resolves.toBe(true)

    const [, init] = transport.mock.calls[0] ?? []
    const body = JSON.parse(String(init?.body))

    expect(body).toEqual({
      model: "jev-1.13.0",
      state: { probe: "availability check" },
      questions: {
        ready: { type: "noul", instructions: "The word `ready` appears in `probe`" },
      },
    })
  })

  it("loads distinct rc.112 and rc.116 Effect modules", async () => {
    const rootRequire = createRequire(import.meta.url)
    const runtimeRequire = createRequire(new URL("../../packages/typesafe-runtime/package.json", import.meta.url))
    const rootEffectPath = rootRequire.resolve("effect/Effect")
    const runtimeEffectPath = runtimeRequire.resolve("effect/Effect")

    expect(rootEffectPath).not.toBe(runtimeEffectPath)
    expect(rootEffectPath).not.toContain("packages/typesafe-runtime")
    expect(runtimeEffectPath).toContain("packages/typesafe-runtime/node_modules/effect")

    const [rootEffect, runtimeEffect] = await Promise.all([
      import(pathToFileURL(rootEffectPath).href),
      import(pathToFileURL(runtimeEffectPath).href),
    ])

    expect(rootEffect).not.toBe(runtimeEffect)
  })
})

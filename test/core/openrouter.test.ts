import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenRouterJudge, isOpenRouterBody, OPENROUTER_CHAT_URL, parseOpenRouterResponse } from "../../src/core/openrouter.ts"
import { contextQuestions, riskQuestions } from "../../src/core/questions.ts"
import { completion, contextCompletion, riskCompletion, riskScores } from "./fixtures/openrouter.ts"

afterEach(() => vi.restoreAllMocks())

describe("parseOpenRouterResponse", () => {
  it("reads the risk fixture and the served model", () => {
    expect(parseOpenRouterResponse(riskCompletion)).toEqual({ risk: riskScores, context: undefined, model: "provider/test-model" })
  })

  it("requires context scores only when requested", () => {
    expect(parseOpenRouterResponse(contextCompletion, true)?.context).toEqual({ authorized: 0.95, off_task: 0.05 })
    expect(parseOpenRouterResponse(riskCompletion, true)).toBeUndefined()
    expect(parseOpenRouterResponse(contextCompletion)?.context).toBeUndefined()
  })

  it.each(["length", "content_filter", "tool_calls"])("rejects unfinished or refused output: %s", (reason) => {
    expect(parseOpenRouterResponse(completion(JSON.stringify(riskScores), reason))).toBeUndefined()
  })

  it.each(["not JSON", "null", "[]", "{}", '"hello"', "```json\n{}\n```"])("rejects malformed answer content: %s", (content) => {
    expect(parseOpenRouterResponse(completion(content))).toBeUndefined()
  })

  it.each([-0.1, 1.1, "0.1", null])("rejects invalid risk probabilities: %s", (score) => {
    expect(parseOpenRouterResponse(completion(JSON.stringify({ ...riskScores, sensitive: score })))).toBeUndefined()
  })

  it("rejects overflowing numbers and invalid context probabilities", () => {
    const overflow = JSON.stringify(riskScores).replace('"destructive":0.1', '"destructive":1e999')

    expect(parseOpenRouterResponse(completion(overflow))).toBeUndefined()
    expect(parseOpenRouterResponse(completion(JSON.stringify({ ...riskScores, authorized: 2, off_task: 0 })), true)).toBeUndefined()
  })

  it("rejects malformed envelopes and refusal messages", () => {
    expect(isOpenRouterBody(null)).toBe(false)
    expect(isOpenRouterBody([])).toBe(false)
    expect(parseOpenRouterResponse({})).toBeUndefined()
    expect(parseOpenRouterResponse({ ...riskCompletion, model: 1 })).toBeUndefined()
    expect(parseOpenRouterResponse({ ...riskCompletion, choices: [] })).toBeUndefined()
    expect(parseOpenRouterResponse({ ...riskCompletion, choices: [null] })).toBeUndefined()
    expect(parseOpenRouterResponse({ ...riskCompletion, choices: [{ finish_reason: "stop", message: { content: null, refusal: "No" } }] })).toBeUndefined()
  })
})

describe("createOpenRouterJudge", () => {
  it.each([undefined, "", "Install packages"])("sends shared questions and optional task: %s", async (task) => {
    const withContext = task !== undefined && task.length > 0
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(withContext ? contextCompletion : riskCompletion))
    const controller = new AbortController()
    const input = task === undefined ? { command: "npm install", cwd: "jevvy" } : { command: "npm install", cwd: "jevvy", task }

    const judged = await createOpenRouterJudge("test-key", "provider/requested-model").judge(input, controller.signal)

    expect(judged.risk).toEqual(riskScores)
    expect(judged.context !== undefined).toBe(withContext)
    expect(transport).toHaveBeenCalledWith(OPENROUTER_CHAT_URL, expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer test-key", "content-type": "application/json" },
      signal: controller.signal,
    }))

    const request = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
    const questions = withContext ? { ...riskQuestions, ...contextQuestions } : riskQuestions

    expect(request.model).toBe("provider/requested-model")
    expect(request.response_format.json_schema.schema.required).toEqual(Object.keys(questions))
    expect(request.messages[1].content).toBe(JSON.stringify(withContext ? input : { command: input.command, cwd: input.cwd }))

    for (const [key, question] of Object.entries(questions)) {
      expect(request.response_format.json_schema.schema.properties[key]).toEqual({ type: "number", minimum: 0, maximum: 1, description: question.instructions })
    }
  })

  it("bounds task context to the TypeSafe adapter's 1200 characters", async () => {
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(contextCompletion))

    await createOpenRouterJudge("key", "model").judge({ command: "npm install", task: "x".repeat(1500) })

    const request = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))

    expect(JSON.parse(request.messages[1].content).task).toHaveLength(1200)
  })

  it("propagates transport cancellation", async () => {
    const aborted = new DOMException("Aborted", "AbortError")

    vi.spyOn(globalThis, "fetch").mockRejectedValue(aborted)

    await expect(createOpenRouterJudge("key", "model").judge({ command: "npm install" }, AbortSignal.abort())).rejects.toBe(aborted)
  })

  it("rejects HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }))

    await expect(createOpenRouterJudge("key", "model").judge({ command: "npm install" })).rejects.toThrow("OpenRouter chat completions 429: rate limited")
  })

  it.each([null, { error: { message: "provider error" } }, riskCompletion])("rejects invalid bodies or missing requested context", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body))

    await expect(createOpenRouterJudge("key", "model").judge({ command: "npm install", task: "Install packages" })).rejects.toThrow("unrecognized body")
  })
})

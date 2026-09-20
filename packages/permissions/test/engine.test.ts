import { describe, expect, it, vi } from "vitest"
import type { JevClient, JevRequest, JevResult } from "@jevvy/core"
import { createPermissionReviewer } from "../src/engine.ts"
import type { ApprovalQuestions } from "../src/questions.ts"

const answer = (value: number): JevResult => ({
  model: "jev-test",
  answers: {
    harmful: { type: "noul", noul: value },
    sensitive: { type: "noul", noul: value },
    untrusted: { type: "noul", noul: value },
    obscured: { type: "noul", noul: value },
  },
})

const fakeClient = (evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResult>): JevClient => ({ evaluate })

describe("permission reviewer", () => {
  it("allows only when every resource independently passes every question", async () => {
    const requests: JevRequest[] = []

    const reviewer = await createPermissionReviewer(fakeClient(async (request) => {
      requests.push(request)

      return answer(0.01)
    }))

    const review = await reviewer.review({ action: "shell", resources: ["git status", "pwd"] })

    expect(review.effect).toBe("allow")
    expect(requests.map((request) => request.state)).toEqual([
      { action: "shell", resource: "git status" },
      { action: "shell", resource: "pwd" },
    ])
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["harmful", "sensitive", "untrusted", "obscured"])
  })

  it("asks when one valid answer crosses its threshold", async () => {
    const reviewer = await createPermissionReviewer(fakeClient(async () => answer(0.9)))

    await expect(reviewer.review({ action: "shell", resources: ["git push --force"] })).resolves.toMatchObject({
      effect: "ask",
      reason: "judged",
    })
  })

  it("caches valid allow and ask judgments for the reviewer lifetime", async () => {
    const evaluate = vi.fn(async (request: JevRequest) =>
      JSON.stringify(request.state).includes("never") ? answer(0.9) : answer(0.01)
    )

    const reviewer = await createPermissionReviewer(fakeClient(evaluate))

    await reviewer.review({ action: "shell", resources: ["pwd"] })
    await reviewer.review({ action: "shell", resources: ["pwd"] })
    await reviewer.review({ action: "shell", resources: ["never"] })
    await reviewer.review({ action: "shell", resources: ["never"] })

    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it("does not cache provider failures or malformed results", async () => {
    let attempts = 0

    const reviewer = await createPermissionReviewer(fakeClient(async () => {
      attempts += 1

      if (attempts === 1) throw new Error("offline")

      if (attempts === 2) return { model: "jev-test", answers: {} }

      return answer(0.01)
    }))

    await expect(reviewer.review({ action: "shell", resources: ["pwd"] })).resolves.toMatchObject({ reason: "unavailable" })
    await expect(reviewer.review({ action: "shell", resources: ["pwd"] })).resolves.toMatchObject({ reason: "unavailable" })
    await expect(reviewer.review({ action: "shell", resources: ["pwd"] })).resolves.toMatchObject({ effect: "allow" })
    expect(attempts).toBe(3)
  })

  it("abstains without a provider call when no resource exists", async () => {
    const evaluate = vi.fn(async () => answer(0.01))
    const reviewer = await createPermissionReviewer(fakeClient(evaluate))

    await expect(reviewer.review({ action: "shell", resources: [] })).resolves.toEqual({
      effect: "ask",
      reason: "empty",
      judgments: [],
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it("supports custom question directions and thresholds", async () => {
    const questions: ApprovalQuestions = {
      harmless: {
        type: "noul",
        instructions: "Is this harmless in this domain?",
        threshold: { direction: "atLeast", value: 0.98 },
      },
    }

    const reviewer = await createPermissionReviewer(fakeClient(async () => ({
      model: "jev-test",
      answers: { harmless: { type: "noul", noul: 0.99 } },
    })), { questions })

    await expect(reviewer.review({ action: "shell", resources: ["domain command"] })).resolves.toMatchObject({ effect: "allow" })
  })

  it("forwards external cancellation instead of converting it to abstention", async () => {
    const reviewer = await createPermissionReviewer(fakeClient(async (_request, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
    ))

    const controller = new AbortController()

    const pending = reviewer.review({ action: "shell", resources: ["pwd"] }, controller.signal)

    controller.abort(new Error("cancelled"))

    await expect(pending).rejects.toThrow("cancelled")
  })
})

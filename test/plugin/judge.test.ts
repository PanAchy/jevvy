import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { JevJudge } from "../../src/core/judge.ts"
import { JudgeService, live } from "../../src/plugin/judge.ts"

describe("JudgeService live layer", () => {
  it("disposes a provider runtime when the layer scope closes", async () => {
    let disposals = 0

    const delegate: JevJudge = {
      judge: () => Promise.reject(new Error("not called")),
      dispose: async () => {
        disposals += 1
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* JudgeService
      }).pipe(
        Effect.provide(live({
          delegate,
          probe: Effect.succeed(true),
          model: "test-model",
          cwd: "/test",
          maxRequestsPerDay: 1,
          budgetStorage: {
            get: () => Effect.succeed(undefined),
            set: () => Effect.void,
          },
        })),
      ),
    )

    expect(disposals).toBe(1)
  })
})

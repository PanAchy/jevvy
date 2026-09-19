// Budget tests: atomic reservation semantics. spend reserves one model
// call, refund returns it when the call never reached the model, the day
// rolls over at midnight, and a persisted snapshot seeds the count.

import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createBudget } from "../../src/plugin/budget.ts"
import type { BudgetStorage } from "../../src/plugin/budget.ts"

const dayKey = `usage/${new Date().toISOString().slice(0, 10)}`

interface StorageHarness {
  readonly storage: BudgetStorage
  readonly entries: Map<string, string>
}

const makeStorage = (initial: ReadonlyMap<string, string> = new Map()): StorageHarness => {
  const entries = new Map(initial)

  return {
    entries,
    storage: {
      get: (key) => Effect.succeed(entries.get(key)),
      set: (key, value) => Effect.sync(() => void entries.set(key, value)),
    },
  }
}

describe("budget", () => {
  it("spends under the cap and persists the reservation", async () => {
    const { storage, entries } = makeStorage()
    const budget = await Effect.runPromise(createBudget(storage, 3))

    expect(await Effect.runPromise(budget.spend)).toBe(true)
    expect(JSON.parse(entries.get(dayKey) ?? "{}")).toMatchObject({ requests: 1 })
  })

  it("refuses once the cap is reserved", async () => {
    const { storage } = makeStorage()
    const budget = await Effect.runPromise(createBudget(storage, 1))

    expect(await Effect.runPromise(budget.spend)).toBe(true)
    expect(await Effect.runPromise(budget.spend)).toBe(false)
    expect(await Effect.runPromise(budget.spend)).toBe(false)
  })

  it("refund returns a reservation", async () => {
    const { storage } = makeStorage()
    const budget = await Effect.runPromise(createBudget(storage, 1))

    expect(await Effect.runPromise(budget.spend)).toBe(true)
    await Effect.runPromise(budget.refund)

    expect(await Effect.runPromise(budget.spend)).toBe(true)
  })

  it("seeds from today's snapshot after a reload", async () => {
    const { storage } = makeStorage(new Map([[dayKey, JSON.stringify({ requests: 2 })]]))
    const budget = await Effect.runPromise(createBudget(storage, 3))

    expect(await Effect.runPromise(budget.spend)).toBe(true)
    expect(await Effect.runPromise(budget.spend)).toBe(false)
  })

  it("a malformed snapshot counts as zero", async () => {
    const { storage } = makeStorage(new Map([[dayKey, "not json"]]))
    const budget = await Effect.runPromise(createBudget(storage, 1))

    expect(await Effect.runPromise(budget.spend)).toBe(true)
  })

  it("rolls over at midnight", async () => {
    const { storage } = makeStorage()
    let fakeDay = "usage/day-1"
    const budget = await Effect.runPromise(createBudget(storage, 1, () => fakeDay))

    await Effect.runPromise(budget.spend)

    expect(await Effect.runPromise(budget.spend)).toBe(false)

    fakeDay = "usage/day-2"

    expect(await Effect.runPromise(budget.spend)).toBe(true)
  })
})

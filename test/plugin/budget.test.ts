// Budget tests: the cap counts model requests per day, persists a snapshot,
// and answers "not allowed" past the limit without ever erroring.

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
  it("allows under the cap and records each call", async () => {
    const { storage, entries } = makeStorage()
    const budget = await Effect.runPromise(createBudget(storage, 3))

    expect(await Effect.runPromise(budget.allow)).toBe(true)
    await Effect.runPromise(budget.record)

    expect(await Effect.runPromise(budget.allow)).toBe(true)
    expect(JSON.parse(entries.get(dayKey) ?? "{}")).toMatchObject({ requests: 1 })
  })

  it("refuses past the cap", async () => {
    const { storage } = makeStorage()
    const budget = await Effect.runPromise(createBudget(storage, 1))

    await Effect.runPromise(budget.record)

    expect(await Effect.runPromise(budget.allow)).toBe(false)
    expect(await Effect.runPromise(budget.allow)).toBe(false)
  })

  it("seeds from today's snapshot after a reload", async () => {
    const { storage } = makeStorage(new Map([[dayKey, JSON.stringify({ requests: 2 })]]))
    const budget = await Effect.runPromise(createBudget(storage, 3))

    expect(await Effect.runPromise(budget.allow)).toBe(true)
    await Effect.runPromise(budget.record)
    await Effect.runPromise(budget.record)

    expect(await Effect.runPromise(budget.allow)).toBe(false)
  })

  it("a malformed snapshot counts as zero", async () => {
    const { storage } = makeStorage(new Map([[dayKey, "not json"]]))
    const budget = await Effect.runPromise(createBudget(storage, 1))

    expect(await Effect.runPromise(budget.allow)).toBe(true)
  })

  it("rolls over at midnight", async () => {
    const { storage } = makeStorage()
    let fakeDay = "usage/day-1"
    const budget = await Effect.runPromise(createBudget(storage, 1, () => fakeDay))

    await Effect.runPromise(budget.record)

    expect(await Effect.runPromise(budget.allow)).toBe(false)

    fakeDay = "usage/day-2"

    expect(await Effect.runPromise(budget.allow)).toBe(true)
  })
})

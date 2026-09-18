// Decision log tests: append-only keys, redaction before storage, and the
// best-effort trim that keeps the log bounded without a read-modify-write.

import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createDecisionLog } from "../../src/plugin/log.ts"
import type { DecisionStorage } from "../../src/plugin/log.ts"
import type { Verdict } from "../../src/core/decision.ts"

interface Stored {
  readonly key: string
  readonly value: string
}

interface StorageHarness {
  readonly storage: DecisionStorage
  readonly entries: Stored[]
}

const makeStorage = (initial: readonly Stored[] = []): StorageHarness => {
  const entries = [...initial]

  return {
    entries,
    storage: {
      set: (key, value) => Effect.sync(() => void entries.push({ key, value: String(value) })),
      scan: (options) =>
        Effect.sync(() => ({
          entries: entries
            .filter((entry) => entry.key.startsWith(options.prefix))
            .sort((a, b) => (a.key < b.key ? -1 : 1))
            .slice(0, options.limit)
            .map((entry) => ({ key: entry.key })),
        })),
      remove: (key) => Effect.sync(() => void (entries.splice(entries.findIndex((entry) => entry.key === key), 1))),
    },
  }
}

const verdict = (effect: Verdict["effect"]): Verdict => ({ effect, reason: "test", source: "jev" })

describe("decision log", () => {
  it("appends one entry per decision as stored text", async () => {
    const { storage, entries } = makeStorage()
    const log = createDecisionLog(storage, true)

    await Effect.runPromise(log.append("ses_1", "git status", verdict("allow")))

    expect(entries).toHaveLength(1)
    expect(entries[0]?.key).toContain("decision/")
    expect(JSON.parse(entries[0]?.value ?? "{}")).toMatchObject({ sessionID: "ses_1", effect: "allow" })
  })

  it("redacts credential shapes before they touch storage", async () => {
    const { storage, entries } = makeStorage()
    const log = createDecisionLog(storage, true)

    await Effect.runPromise(log.append("ses_1", "export API_KEY=tsk_abcdefgh12345678", verdict("ask")))

    const stored = entries[0]?.value ?? ""

    expect(stored).toContain("[redacted]")
    expect(stored).not.toContain("tsk_")
  })

  it("concurrent appends never overwrite each other", async () => {
    const { storage, entries } = makeStorage()
    const log = createDecisionLog(storage, true)

    await Effect.runPromise(
      Effect.all([log.append("ses_1", "ls", verdict("allow")), log.append("ses_2", "pwd", verdict("allow"))], {
        discard: true,
      }),
    )

    expect(entries).toHaveLength(2)
  })

  it("trims the oldest entries past the keep limit", async () => {
    const initial = Array.from({ length: 250 }, (_, i) => ({
      key: `decision/${(i + 1).toString().padStart(16, "0")}`,
      value: "{}",
    }))

    const { storage, entries } = makeStorage(initial)
    const log = createDecisionLog(storage, true)

    await Effect.runPromise(log.append("ses_1", "ls", verdict("allow")))

    expect(entries.length).toBeLessThanOrEqual(251)
    expect(entries.length).toBeGreaterThanOrEqual(200)
    // the newest key (just appended, highest) survives
    expect(entries.at(-1)?.key).not.toBe(initial[0]?.key)
  })

  it("a disabled log stores nothing", async () => {
    const { storage, entries } = makeStorage()
    const log = createDecisionLog(storage, false)

    await Effect.runPromise(log.append("ses_1", "ls", verdict("allow")))

    expect(entries).toHaveLength(0)
  })
})

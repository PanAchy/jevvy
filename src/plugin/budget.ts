// Daily request budget for the judge. A gate that runs on every command is
// one runaway agent loop away from a surprise bill, so the Live layer asks
// the budget before every model call. Single writer per plugin instance:
// an in-memory counter is authoritative, a daily snapshot in storage seeds
// it after reloads, and exceeding the cap answers None (unavailable), never
// an error.

import { Effect } from "effect"
import type { Schema } from "effect"

/** The slice of plugin storage the budget needs. */
export interface BudgetStorage {
  readonly get: (key: string) => Effect.Effect<Schema.Json | undefined>
  readonly set: (key: string, value: string) => Effect.Effect<void>
}

export interface Budget {
  /** Whether a model call may proceed right now. */
  readonly allow: Effect.Effect<boolean>
  /** Counts one model call against today. */
  readonly record: Effect.Effect<void>
}

const dayKey = (): string => `usage/${new Date().toISOString().slice(0, 10)}`

interface UsageSnapshot {
  requests: number
}

const isUsageSnapshot = (u: unknown): u is UsageSnapshot =>
  typeof u === "object" && u !== null && "requests" in u && typeof u.requests === "number" && Number.isFinite(u.requests)

const parseSnapshot = (stored: string | undefined): UsageSnapshot => {
  if (stored === undefined) return { requests: 0 }

  try {
    const parsed: unknown = JSON.parse(stored)

    return isUsageSnapshot(parsed) ? parsed : { requests: 0 }
  } catch {
    return { requests: 0 }
  }
}

const isStoredText = (u: unknown): u is string => typeof u === "string"

export const createBudget = (storage: BudgetStorage, maxRequestsPerDay: number): Effect.Effect<Budget> =>
  Effect.gen(function* () {
    let warned = false

    const stored = yield* storage.get(dayKey()).pipe(Effect.orDie)
    const seed = parseSnapshot(isStoredText(stored) ? stored : undefined)
    let requests = seed.requests

    const persist = (count: number): Effect.Effect<void> =>
      storage.set(dayKey(), JSON.stringify({ requests: count })).pipe(
        Effect.catch((error) => Effect.logWarning("[jevvy] budget snapshot failed", { error: String(error) })),
      )

    return {
      allow: Effect.sync(() => requests < maxRequestsPerDay).pipe(
        Effect.flatMap((allowed) =>
          allowed
            ? Effect.succeed(true)
            : warned
              ? Effect.succeed(false)
              : Effect.logWarning("[jevvy] daily request budget reached - judge offline until tomorrow", {
                  maxRequestsPerDay,
                }).pipe(
                  Effect.flatMap(() => Effect.sync(() => (warned = true))),
                  Effect.as(false),
                ),
        ),
      ),
      record: Effect.sync(() => {
        requests += 1

        return requests
      }).pipe(Effect.flatMap(persist)),
    }
  })

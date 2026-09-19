// Daily request budget for the judge. A gate that runs on every command is
// one runaway agent loop away from a surprise bill, so the Live layer asks
// the budget before every model call. All state lives in one SynchronizedRef
// so check, increment, rollover, and the day's warning flag are atomic under
// concurrent verdicts; a daily snapshot in storage seeds it after reloads.
// Exceeding the cap answers None (unavailable), never an error.

import { Effect, SynchronizedRef } from "effect"

/** The slice of plugin storage the budget needs. */
export interface BudgetStorage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: string) => Effect.Effect<void>
}

export interface Budget {
  /** Atomically reserves one model call. False: the day is capped. */
  readonly spend: Effect.Effect<boolean>
  /** Returns a reservation when the call failed and never reached the model. */
  readonly refund: Effect.Effect<void>
}

interface BudgetState {
  readonly day: string
  readonly requests: number
  readonly warned: boolean
}

const dayKey = (): string => `usage/${new Date().toISOString().slice(0, 10)}`

type CurrentDay = () => string

const rolled = (state: BudgetState, currentDay: CurrentDay): BudgetState => {
  const today = currentDay()

  if (today === state.day) return state

  // Midnight rollover: a plugin that stays loaded for days must not stay
  // exhausted forever, and the cap warning must fire again each day.
  return { day: today, requests: 0, warned: false }
}

const isStoredText = (u: unknown): u is string => typeof u === "string"

const parseSeed = (stored: string | undefined): number => {
  if (stored === undefined) return 0

  try {
    const parsed: unknown = JSON.parse(stored)

    // A malformed snapshot counts as zero rather than disabling the judge.
    return isSeedRecord(parsed) ? parsed.requests : 0
  } catch {
    return 0
  }
}

interface SeedRecord {
  readonly requests: number
}

const isSeedRecord = (u: unknown): u is SeedRecord =>
  typeof u === "object" && u !== null && "requests" in u && typeof u.requests === "number" && Number.isFinite(u.requests)

export const createBudget = (
  storage: BudgetStorage,
  maxRequestsPerDay: number,
  currentDay: CurrentDay = dayKey,
): Effect.Effect<Budget> =>
  Effect.gen(function* () {
    const stored = yield* storage.get(dayKey()).pipe(Effect.orDie)

    const state = yield* SynchronizedRef.make<BudgetState>({
      day: dayKey(),
      requests: parseSeed(isStoredText(stored) ? stored : undefined),
      warned: false,
    })

    const persist = (count: number): Effect.Effect<void> =>
      storage.set(dayKey(), JSON.stringify({ requests: count })).pipe(
        Effect.catch((error) => Effect.logWarning("[jevvy] budget snapshot failed", { error: String(error) })),
      )

    return {
      allow: SynchronizedRef.modifyEffect(state, (current) => {
        const next = rolled(current, currentDay)

        if (next.requests < maxRequestsPerDay) return Effect.succeed([true, next] as const)

        if (next.warned) return Effect.succeed([false, next] as const)

        return Effect.logWarning("[jevvy] daily request budget reached - judge offline until tomorrow", {
          maxRequestsPerDay,
        }).pipe(Effect.as([false, { ...next, warned: true }] as const))
      }),
      spend: SynchronizedRef.modifyEffect(state, (current) => {
        const next = rolled(current, currentDay)

        if (next.requests < maxRequestsPerDay) {
          const reserved = { ...next, requests: next.requests + 1 }

          return persist(reserved.requests).pipe(Effect.as([true, reserved] as const))
        }

        if (next.warned) return Effect.succeed([false, next] as const)

        return Effect.logWarning("[jevvy] daily request budget reached - judge offline until tomorrow", {
          maxRequestsPerDay,
        }).pipe(Effect.as([false, { ...next, warned: true }] as const))
      }),
      refund: SynchronizedRef.modifyEffect(state, (current) => {
        const rolledState = rolled(current, currentDay)
        const next = { ...rolledState, requests: Math.max(0, rolledState.requests - 1) }

        return persist(next.requests).pipe(Effect.as([undefined, next] as const))
      }),
    }
  })

// Append-only decision log. Each decision writes its own storage key, so
// concurrent verdicts never drop entries the way a read-modify-write on one
// shared key did. Secrets are redacted before anything touches storage.

import { Effect } from "effect"
import type { Schema } from "effect"
import { redactSecrets } from "../core/floor.ts"
import type { Verdict } from "../core/decision.ts"

/** The slice of plugin storage the log needs, for testability. */
export interface DecisionStorage {
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>
  readonly scan: (options: { readonly prefix: string; readonly limit: number }) => Effect.Effect<{
    readonly entries: readonly { readonly key: string }[]
    readonly next?: string
  }>
  readonly remove: (key: string) => Effect.Effect<void>
}

export interface DecisionLog {
  readonly append: (sessionID: string, command: string, verdict: Verdict) => Effect.Effect<void>
}

const PREFIX = "decision/"

const KEEP = 200

const SCAN_LIMIT = 500

const TRIM_EVERY = 25

let sequence = 0

let appends = 0

// Fixed-width base-36 keeps keys lexicographically ordered: time first,
// then a process-local sequence for same-millisecond decisions.
const nextKey = (): string => {
  sequence += 1

  return `${PREFIX}${Date.now().toString(36).padStart(10, "0")}${sequence.toString(36).padStart(6, "0")}`
}

const trimToKeep = (storage: DecisionStorage): Effect.Effect<void> =>
  Effect.gen(function* () {
    const page = yield* storage.scan({ prefix: PREFIX, limit: SCAN_LIMIT })
    const overflow = page.entries.length - KEEP

    if (overflow <= 0) return

    // Entries come back in key order, so the oldest are first.
    for (const entry of page.entries.slice(0, overflow)) {
      yield* storage.remove(entry.key)
    }
  })

export const createDecisionLog = (storage: DecisionStorage, enabled: boolean): DecisionLog => ({
  append: (sessionID, command, verdict) =>
    Effect.gen(function* () {
      if (!enabled) return

      const entry = {
        time: new Date().toISOString(),
        sessionID,
        command: redactSecrets(command).slice(0, 500),
        effect: verdict.effect,
        source: verdict.source,
        reason: verdict.reason,
        judged: verdict.judged ?? null,
      }

      // Stored as text: nested domain types cannot prove themselves as Json,
      // and one parse at read time is cheaper than a mirror type tree.
      yield* storage.set(nextKey(), JSON.stringify(entry))

      // Best effort and occasional: a scan per append would tax every
      // verdict for a cap that only matters occasionally.
      appends += 1

      if (appends % TRIM_EVERY === 0) {
        yield* trimToKeep(storage).pipe(
          Effect.catch((error) => Effect.logWarning("[jevvy] decision log trim failed", { error: String(error) })),
        )
      }
    }).pipe(
      Effect.catch((error) => Effect.logWarning("[jevvy] decision log append failed", { error: String(error) })),
    ),
})

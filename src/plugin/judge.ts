// JudgeService: the Effect seam over the agnostic Jev adapter.
//
// judge() answers Option<Judged>: Some when the model answered, None when it
// is unavailable (no key, timeout, API error). There is no failure channel,
// so callers stay in plain workflow code with no catching, and a fake for
// tests is one line. The Live layer owns a bounded cache, so repeated
// commands cost one judgment, not many; cached misses (None) expire with the
// entry like everything else.

import { Cache, Context, Effect, Exit, Layer, Option, SynchronizedRef } from "effect"
import type { JevJudge } from "../core/judge.ts"
import type { CommandInput, Judged } from "../core/decision.ts"
import { createBudget } from "./budget.ts"
import type { Budget, BudgetStorage } from "./budget.ts"

export interface Judge {
  /** "degraded" means no key was configured: stay out of the way entirely.
   *  "live" means a judge exists, so an unavailable answer fails closed. */
  readonly availability: "live" | "degraded"
  readonly judge: (input: CommandInput) => Effect.Effect<Option.Option<Judged>>
}

export class JudgeService extends Context.Service<JudgeService, Judge>()("@jevvy/JudgeService") {}

const CACHE_CAPACITY = 512

const CACHE_TTL_MS = 300_000

// Unavailable answers (None) expire fast: a short-lived outage or timeout
// must not be held against the command for the full cache lifetime.
const NONE_TTL_MS = 5_000

const JUDGMENT_TIMEOUT_MS = 5_000

export const DEFAULT_MAX_REQUESTS_PER_DAY = 2_000

const MODEL_REPROBE_INTERVAL_MS = 60_000

interface ProbeState {
  readonly verified: boolean
  readonly probedAt: number
}

// Commands are judge keys as plain strings: object keys fall back to
// reference equality in the cache and would never hit.
const KEY_SEPARATOR = "\u0000"

const keyOf = (input: CommandInput): string => `${input.command}${KEY_SEPARATOR}${input.task ?? ""}`

const lookupJudged = (delegate: JevJudge, cwd: string, budget: Budget, key: string): Effect.Effect<Option.Option<Judged>> =>
  Effect.gen(function* () {
    // Reserve before the call: check-and-count is one atomic step, so
    // concurrent verdicts cannot jointly exceed the cap.
    if (!(yield* budget.spend)) return Option.none<Judged>()

    const separatorIndex = key.indexOf(KEY_SEPARATOR)
    const command = key.slice(0, separatorIndex)
    const task = key.slice(separatorIndex + 1)

    const input: CommandInput = task.length > 0 ? { command, cwd, task } : { command, cwd }

    // Infallible by design: errors and timeouts answer None so failure exits
    // never poison the cache, and unavailable stays a value, not an error.
    // The signal makes Effect timeouts real: the HTTP call dies with them.
    const judged = yield* Effect.tryPromise((signal) => delegate.judge(input, signal)).pipe(
      Effect.timeout(JUDGMENT_TIMEOUT_MS),
      Effect.catch((error) =>
        Effect.logWarning("[jevvy] judge unavailable", { error: String(error) }).pipe(Effect.as(undefined)),
      ),
    )

    // The call failed or timed out: give the reservation back.
    if (judged === undefined || judged === null) yield* budget.refund

    return judged === undefined || judged === null ? Option.none<Judged>() : Option.some(judged)
  })

/** Construction inputs for the Live judge layer. The delegate is the
 *  provider adapter (TypeSafe or zen); the probe verifies the provider is
 *  serving before the first verdict. */
export interface LiveConfig {
  readonly delegate: JevJudge
  readonly probe: Effect.Effect<boolean>
  readonly model: string
  readonly cwd: string
  readonly maxRequestsPerDay: number
  readonly budgetStorage: BudgetStorage
}

export const live = (config: LiveConfig): Layer.Layer<JudgeService> =>
  Layer.effect(
    JudgeService,
    Effect.gen(function* () {
      const resolvedModel = config.model

      // A failed probe latches degraded, but only for a bounded window: a
      // transient error at load must not kill the judge until a manual
      // reload. The latch is one SynchronizedRef so concurrent verdicts
      // re-probe at most once per interval.
      const initialVerified = yield* config.probe

      const probeState = yield* SynchronizedRef.make<ProbeState>({
        verified: initialVerified,
        probedAt: Date.now(),
      })

      if (!initialVerified) {
        yield* Effect.logError("[jevvy] pinned model not available - judge degraded, will re-probe", { model: resolvedModel })
      }

      const delegate = config.delegate
      const budget = yield* createBudget(config.budgetStorage, config.maxRequestsPerDay)

      const cache = yield* Cache.makeWith(
        (key: string) => lookupJudged(delegate, config.cwd, budget, key),
        {
          capacity: CACHE_CAPACITY,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) && Option.isNone(exit.value) ? NONE_TTL_MS : CACHE_TTL_MS,
        },
      )

      const nextState = (verified: boolean): ProbeState => ({ verified, probedAt: Date.now() })

      const reprobeIfDue = SynchronizedRef.modifyEffect(probeState, (current) => {
        if (current.verified || Date.now() - current.probedAt <= MODEL_REPROBE_INTERVAL_MS) {
          return Effect.succeed([undefined, current] as const)
        }

        return config.probe.pipe(
          Effect.flatMap((verified) =>
            verified
              ? Effect.logInfo("[jevvy] model available again - judge live", { model: resolvedModel }).pipe(
                  Effect.as([undefined, nextState(true)] as const),
                )
              : Effect.succeed([undefined, nextState(false)] as const),
          ),
        )
      })

      return JudgeService.of({
        availability: "live",
        judge: (input) =>
          Effect.gen(function* () {
            yield* reprobeIfDue

            const state = yield* SynchronizedRef.get(probeState)

            if (!state.verified) return Option.none<Judged>()

            return yield* Cache.get(cache, keyOf(input))
          }),
      })
    }),
  )

export const degraded = Layer.succeed(
  JudgeService,
  JudgeService.of({
    availability: "degraded",
    judge: () => Effect.succeed(Option.none<Judged>()),
  }),
)

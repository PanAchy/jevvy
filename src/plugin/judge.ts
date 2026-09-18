// JudgeService: the Effect seam over the agnostic Jev adapter.
//
// judge() answers Option<Judged>: Some when the model answered, None when it
// is unavailable (no key, timeout, API error). There is no failure channel,
// so callers stay in plain workflow code with no catching, and a fake for
// tests is one line. The Live layer owns a bounded cache, so repeated
// commands cost one judgment, not many; cached misses (None) expire with the
// entry like everything else.

import { Cache, Context, Effect, Exit, Layer, Option, Redacted } from "effect"
import { createJudge, DEFAULT_MODEL, modelAvailable } from "../core/judge.ts"
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

// Commands are judge keys as plain strings: object keys fall back to
// reference equality in the cache and would never hit.
const KEY_SEPARATOR = "\u0000"

const keyOf = (input: CommandInput): string => `${input.command}${KEY_SEPARATOR}${input.task ?? ""}`

const lookupJudged = (delegate: JevJudge, cwd: string, budget: Budget, key: string): Effect.Effect<Option.Option<Judged>> =>
  Effect.gen(function* () {
    if (!(yield* budget.allow)) return Option.none<Judged>()

    const separatorIndex = key.indexOf(KEY_SEPARATOR)
    const command = key.slice(0, separatorIndex)
    const task = key.slice(separatorIndex + 1)

    const input: CommandInput = task.length > 0 ? { command, cwd, task } : { command, cwd }

    // Infallible by design: errors and timeouts answer None so failure exits
    // never poison the cache, and unavailable stays a value, not an error.
    const judged = yield* Effect.tryPromise(() => delegate.judge(input)).pipe(
      Effect.timeout(JUDGMENT_TIMEOUT_MS),
      Effect.catch((error) =>
        Effect.logWarning("[jevvy] judge unavailable", { error: String(error) }).pipe(Effect.as(undefined)),
      ),
    )

    // Count successful model calls only: an outage that answers None must
    // not burn quota on every retry.
    if (judged !== undefined && judged !== null) yield* budget.record

    return judged === undefined || judged === null ? Option.none<Judged>() : Option.some(judged)
  })

/** Construction inputs for the Live judge layer. */
export interface LiveConfig {
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string | undefined
  readonly cwd: string
  readonly maxRequestsPerDay: number
  readonly budgetStorage: BudgetStorage
}

export const live = (config: LiveConfig): Layer.Layer<JudgeService> =>
  Layer.effect(
    JudgeService,
    Effect.gen(function* () {
      const resolvedModel = config.model ?? DEFAULT_MODEL

      // Runtime verification: the pinned model must be serving under this
      // key, else this load degrades to code tiers with a loud log. A
      // transient failure here costs one plugin reload, not a silent gate.
      const probe = Effect.tryPromise(() => modelAvailable(Redacted.value(config.apiKey), resolvedModel)).pipe(
        Effect.timeout(JUDGMENT_TIMEOUT_MS),
        Effect.catch((error) =>
          Effect.logError("[jevvy] model check failed - judge degraded", { error: String(error) }).pipe(Effect.as(false)),
        ),
      )

      // A failed probe latches degraded, but only for a bounded window: a
      // transient error at load must not kill the judge until a manual
      // reload. Lazy re-probe, at most once per interval.
      let verified = yield* probe
      let probedAt = Date.now()

      if (!verified) {
        yield* Effect.logError("[jevvy] pinned model not available - judge degraded, will re-probe", { model: resolvedModel })
      }

      const delegate = createJudge(Redacted.value(config.apiKey), config.model)
      const budget = yield* createBudget(config.budgetStorage, config.maxRequestsPerDay)

      const cache = yield* Cache.makeWith(
        (key: string) => lookupJudged(delegate, config.cwd, budget, key),
        {
          capacity: CACHE_CAPACITY,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) && Option.isNone(exit.value) ? NONE_TTL_MS : CACHE_TTL_MS,
        },
      )

      return JudgeService.of({
        availability: "live",
        judge: (input) =>
          Effect.gen(function* () {
            if (!verified && Date.now() - probedAt > MODEL_REPROBE_INTERVAL_MS) {
              verified = yield* probe
              probedAt = Date.now()

              if (verified) {
                yield* Effect.logInfo("[jevvy] model available again - judge live", { model: resolvedModel })
              }
            }

            if (!verified) return Option.none<Judged>()

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

/** Construction inputs for choosing between the Live and Degraded layers. */
export interface LayerConfig {
  readonly apiKey: Option.Option<Redacted.Redacted<string>>
  readonly model: string | undefined
  readonly cwd: string
  readonly maxRequestsPerDay: number
  readonly budgetStorage: BudgetStorage
}

export const layerFor = (config: LayerConfig): Layer.Layer<JudgeService> =>
  Option.isNone(config.apiKey)
    ? degraded
    : live({
        apiKey: config.apiKey.value,
        model: config.model,
        cwd: config.cwd,
        maxRequestsPerDay: config.maxRequestsPerDay,
        budgetStorage: config.budgetStorage,
      })

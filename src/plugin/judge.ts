// JudgeService: the Effect seam over the agnostic Jev adapter.
//
// judge() answers Option<Judged>: Some when the model answered, None when it
// is unavailable (no key, timeout, API error). There is no failure channel,
// so callers stay in plain workflow code with no catching, and a fake for
// tests is one line. The Live layer owns a bounded cache, so repeated
// commands cost one judgment, not many; cached misses (None) expire with the
// entry like everything else.

import { Cache, Context, Effect, Layer, Option, Redacted } from "effect"
import { createJudge } from "../core/judge.ts"
import type { JevJudge } from "../core/judge.ts"
import type { CommandInput, Judged } from "../core/decision.ts"

export interface Judge {
  readonly judge: (input: CommandInput) => Effect.Effect<Option.Option<Judged>>
}

export class JudgeService extends Context.Service<JudgeService, Judge>()("@jevvy/JudgeService") {}

const CACHE_CAPACITY = 512

const CACHE_TTL_MS = 300_000

const JUDGMENT_TIMEOUT_MS = 5_000

// Commands are judge keys as plain strings: object keys fall back to
// reference equality in the cache and would never hit.
const KEY_SEPARATOR = "\u0000"

const keyOf = (input: CommandInput): string => `${input.command}${KEY_SEPARATOR}${input.task ?? ""}`

const lookupJudged = (delegate: JevJudge, cwd: string, key: string): Effect.Effect<Option.Option<Judged>> =>
  Effect.gen(function* () {
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

    return judged === undefined || judged === null ? Option.none<Judged>() : Option.some(judged)
  })

export const live = (apiKey: Redacted.Redacted<string>, model: string | undefined, cwd: string): Layer.Layer<JudgeService> =>
  Layer.effect(
    JudgeService,
    Effect.gen(function* () {
      const delegate = createJudge(Redacted.value(apiKey), model)

      const cache = yield* Cache.make({
        capacity: CACHE_CAPACITY,
        timeToLive: CACHE_TTL_MS,
        lookup: (key: string) => lookupJudged(delegate, cwd, key),
      })

      return JudgeService.of({
        judge: (input) => Cache.get(cache, keyOf(input)),
      })
    }),
  )

export const degraded = Layer.succeed(
  JudgeService,
  JudgeService.of({
    judge: () => Effect.succeed(Option.none<Judged>()),
  }),
)

export const layerFor = (
  apiKey: Option.Option<Redacted.Redacted<string>>,
  model: string | undefined,
  cwd: string,
): Layer.Layer<JudgeService> =>
  Option.isNone(apiKey) ? degraded : live(apiKey.value, model, cwd)

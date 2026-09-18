// The OpenCode V2 Effect plugin - thin wiring around the modules.

import { Config, Effect, Option } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import { config as loadEnv } from "dotenv"
import { defaultThresholds } from "../core/decision.ts"
import type { Thresholds } from "../core/decision.ts"
import { Session } from "@opencode/schema/session"
import { layerFor, DEFAULT_MAX_REQUESTS_PER_DAY } from "./judge.ts"
import { createDecisionLog } from "./log.ts"
import { isPluginOptionsInput, parseOptions } from "./options.ts"
import { extractTask, createEvaluate } from "./pipeline.ts"

/** Thresholds with readonly stripped, so defaults can be overridden in place. */
type MutableThresholds = { -readonly [K in keyof Thresholds]: Thresholds[K] }

export default Plugin.define({
  id: "jevvy",
  effect: (ctx) =>
    Effect.gen(function* () {
      const project = ctx.location.directory
      const options = isPluginOptionsInput(ctx.options) ? parseOptions(ctx.options) : {}

      const hasRawOverrides = isPluginOptionsInput(ctx.options) && Object.keys(ctx.options).length > 0
      const parsedNothing = Object.keys(options).length === 0

      if (hasRawOverrides && parsedNothing) {
        yield* Effect.logWarning("[jevvy] plugin options failed schema validation - using defaults")
      }

      // Step-wise threshold assembly: defaults, then any explicit overrides.
      const thresholds: MutableThresholds = { ...defaultThresholds }
      const overrides = options.thresholds

      if (overrides !== undefined) {
        if (overrides.highRisk !== undefined) thresholds.highRisk = overrides.highRisk

        if (overrides.ask !== undefined) thresholds.ask = overrides.ask

        if (overrides.allow !== undefined) thresholds.allow = overrides.allow

        if (overrides.authorized !== undefined) thresholds.authorized = overrides.authorized
      }

      const dryRun = options.dryRun === true

      // dotenv runs once at the adapter edge; Config is the only reader of
      // the environment from here on. A missing key degrades the judge to
      // code tiers only, never a failed plugin load.
      loadEnv({ path: `${project}/.env`, quiet: true })
      const apiKey = yield* Config.option(Config.redacted("TYPESAFE_API_KEY")).pipe(Effect.orDie)

      if (Option.isNone(apiKey)) {
        yield* Effect.logWarning("[jevvy] TYPESAFE_API_KEY not set - code tiers only, no model calls")
      }

      const judgeLayer = layerFor({
        apiKey,
        model: options.model,
        cwd: project,
        maxRequestsPerDay: options.maxRequestsPerDay ?? DEFAULT_MAX_REQUESTS_PER_DAY,
        budgetStorage: ctx.storage,
      })

      // Fail closed on task context: if the session cannot be read, judge
      // without context axes rather than dying mid-evaluation. The id was
      // branded upstream in the SDK event; descending() re-brands it.
      const sessionTask = (sessionID: string): Effect.Effect<string | undefined> =>
        ctx.session.context({ sessionID: Session.ID.descending(sessionID) }).pipe(
          Effect.timeout(2_000),
          Effect.catch(() => Effect.succeed(undefined)),
          Effect.map((messages) => extractTask(messages ?? [])),
        )

      const evaluate = yield* createEvaluate(
        { thresholds, dryRun, notePerAllow: options.notePerAllow === true },
        {
          project,
          sessionTask,
          log: createDecisionLog(ctx.storage, options.noLog !== true),
          note: (sessionID, text) =>
            ctx.session.synthetic({ sessionID: Session.ID.descending(sessionID), text }).pipe(
              Effect.asVoid,
              Effect.catch((error) => Effect.logWarning("[jevvy] note post failed", { error: String(error) })),
            ),
        },
      ).pipe(Effect.provide(judgeLayer))

      yield* Effect.logInfo("[jevvy] loaded", {
        project,
        dryRun,
        model: options.model ?? "jev-1.13.0",
        judge: Option.isSome(apiKey) ? "live" : "degraded",
      })

      yield* ctx.permission.hook("evaluate", (event) => evaluate(event))
    }),
})

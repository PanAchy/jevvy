// The OpenCode V2 Effect plugin - thin wiring around the modules.

import { Effect } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import { OpenCode } from "@opencode/client"
import { discover, headers as serviceHeaders } from "@opencode/client/service"
import { config as loadEnv } from "dotenv"
import { defaultThresholds } from "../core/decision.ts"
import type { Thresholds } from "../core/decision.ts"
import { Session } from "@opencode/schema/session"
import { createJudge, DEFAULT_MODEL, modelAvailable } from "../core/judge.ts"
import type { JevJudge } from "../core/judge.ts"
import { createZenJudge } from "../core/zen.ts"
import { degraded, live, DEFAULT_MAX_REQUESTS_PER_DAY } from "./judge.ts"
import { credentialToken, OPENCODE_INTEGRATION, resolveCredential, TYPESAFE_INTEGRATION, ZEN_INTEGRATION } from "./credentials.ts"
import type { ConnectionLike, StoredCredential } from "./credentials.ts"
import { createDecisionLog } from "./log.ts"
import { isPluginOptionsInput, parseOptions } from "./options.ts"
import { extractTask, createEvaluate } from "./pipeline.ts"
import { isRememberedApproval } from "./approvals.ts"

/** Thresholds with readonly stripped, so defaults can be overridden in place. */
type MutableThresholds = { -readonly [K in keyof Thresholds]: Thresholds[K] }

/** Describe the SDK's connection to the pure resolution logic. */
const describeConnection = (info: { type: string; id?: string; name?: string }): ConnectionLike =>
  info.type === "env" ? { kind: "env", envName: info.name } : { kind: "credential", credentialID: info.id }

/** Keep only the provider credential fields jevvy needs. */
const storedCredentialFrom = (value: {
  readonly type: "key" | "oauth"
  readonly key?: string
  readonly access?: string
  readonly configuration?: Readonly<Record<string, string | number | boolean | readonly string[]>>
} | undefined): StoredCredential | undefined => {
  if (value?.type === "key" && value.key !== undefined) {
    return { type: "key", key: value.key, configuration: value.configuration }
  }

  if (value?.type === "oauth" && value.access !== undefined) return { type: "oauth", access: value.access }

  return undefined
}

export default Plugin.define({
  id: "jevvy",
  effect: (ctx) =>
    Effect.gen(function* () {
      const project = ctx.location.directory
      const options = isPluginOptionsInput(ctx.options) ? parseOptions(ctx.options) : {}

      const service = yield* Effect.tryPromise(() => discover()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("[jevvy] could not discover opencode service - remembered approvals unavailable", {
            error: String(error),
          }).pipe(Effect.as(undefined)),
        ),
      )

      const client = service === undefined
        ? undefined
        : OpenCode.make({ baseUrl: service.url, headers: serviceHeaders(service) })

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

      // dotenv runs once at the adapter edge. Two integrations put keys in
      // opencode's credential store with a connect UI - never config files.
      loadEnv({ path: `${project}/.env`, quiet: true })

      yield* ctx.integration.transform((editor) => {
        editor.update(TYPESAFE_INTEGRATION, (ref) => {
          ref.name = "Jevvy (TypeSafe)"
        })

        editor.method.update({
          integrationID: TYPESAFE_INTEGRATION,
          method: {
            type: "key",
            label: "TypeSafe API key",
            form: [{ key: "key", type: "string", title: "TypeSafe API key", placeholder: "tsk_...", required: true }],
          },
        })

        editor.method.update({
          integrationID: TYPESAFE_INTEGRATION,
          method: { type: "env", names: ["TYPESAFE_API_KEY"] },
        })

        editor.update(ZEN_INTEGRATION, (ref) => {
          ref.name = "Jevvy (zen)"
        })

        editor.method.update({
          integrationID: ZEN_INTEGRATION,
          method: {
            type: "key",
            label: "opencode token (zen)",
            form: [
              {
                key: "key",
                type: "string",
                title: "opencode access token",
                description: "Used as x-api-key against opencode.ai/zen. The free Jev model costs nothing.",
                required: true,
              },
              {
                key: "model",
                type: "string",
                title: "Model",
                default: "jev-1.13-free",
                options: [{ value: "jev-1.13-free", label: "jev-1.13-free ($0)" }],
              },
            ],
          },
        })

        editor.method.update({
          integrationID: ZEN_INTEGRATION,
          method: { type: "env", names: ["OPENCODE_TOKEN", "JEVZY_ZEN_TOKEN"] },
        })
      })

      // Credentials resolve zen-first (free), then TypeSafe: integration
      // store first, then env. No credential means code tiers only.
      const credential = yield* resolveCredential(
        {
          activeIntegration: (id) => ctx.integration.connection.active(id),
          resolveIntegration: (connection) =>
            ctx.integration.connection.resolve(connection).pipe(
              Effect.map(storedCredentialFrom),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          readEnv: (name) => process.env[name],
        },
        options.provider,
        describeConnection,
      )

      const opencodeZenJudge: JevJudge = {
        judge: async (input, signal) => {
          const token = await Effect.runPromise(
            ctx.integration.connection.active(OPENCODE_INTEGRATION).pipe(
              Effect.flatMap((connection) =>
                connection === undefined
                  ? Effect.succeed(undefined)
                  : ctx.integration.connection.resolve(connection).pipe(Effect.map(storedCredentialFrom)),
              ),
              Effect.map(credentialToken),
            ),
          )

          if (token === undefined) throw new Error("opencode login is unavailable")

          return createZenJudge(token, credential.kind === "zen" ? credential.model : undefined).judge(input, signal)
        },
      }

      const judgeLayer =
        credential.kind === "degraded"
          ? degraded
          : live({
              delegate:
                credential.kind === "zen"
                  ? credential.origin === "opencode"
                    ? opencodeZenJudge
                    : createZenJudge(credential.key, credential.model)
                  : createJudge(credential.key),
              probe:
                credential.kind === "typesafe"
                  ? Effect.tryPromise((signal) => modelAvailable(credential.key, options.model ?? DEFAULT_MODEL, signal)).pipe(
                      Effect.timeout(5_000),
                      Effect.catch((error) =>
                        Effect.logError("[jevvy] model check failed", { error: String(error) }).pipe(Effect.as(false)),
                      ),
                    )
                  : Effect.succeed(true),
              model: credential.kind === "zen" ? credential.model : (options.model ?? DEFAULT_MODEL),
              cwd: project,
              maxRequestsPerDay: options.maxRequestsPerDay ?? DEFAULT_MAX_REQUESTS_PER_DAY,
              budgetStorage: ctx.storage,
            })

      if (credential.kind === "degraded") {
        yield* Effect.logWarning("[jevvy] no provider credential - code tiers only, no model calls")
      }

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
          isRememberedApproval: (action, resources) =>
            client === undefined
              ? Effect.succeed(false)
              : Effect.tryPromise(() => client.permission.saved.list({ projectID: ctx.location.project.id })).pipe(
                  Effect.map((approvals) => isRememberedApproval(approvals, action, resources)),
                  Effect.catch(() => Effect.succeed(false)),
                ),
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
        provider: credential.kind,
        model: credential.kind === "zen" ? credential.model : (options.model ?? DEFAULT_MODEL),
        judge: credential.kind === "degraded" ? "degraded" : `live:${credential.kind}`,
      })

      yield* ctx.permission.hook("evaluate", (event) => evaluate(event))
    }),
})

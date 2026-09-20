import { createZenClient, JevProviderError } from "../core.ts"
import type { JevClient } from "../core.ts"
import { Credential, Plugin } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import { Effect } from "effect"
import { loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import { createEvaluate } from "./evaluate.ts"
import {
  credentialToken,
  OPENCODE_INTEGRATION,
  selectOpenCodeProvider,
} from "./credentials.ts"
import type { StoredCredential } from "./credentials.ts"

const describeConnection = (connection: ConnectionInfo) =>
  connection.type === "env"
    ? { kind: "env" as const, envName: connection.name }
    : { kind: "credential" as const }

const storedCredentialFrom = (credential: Credential.Value | undefined): StoredCredential | undefined => {
  if (credential?.type === "key") {
    return { type: "key", key: credential.key, configuration: credential.configuration }
  }

  if (credential?.type === "oauth") return { type: "oauth", access: credential.access }

  return undefined
}

export default Plugin.define({
  id: "jevvy.permissions",
  effect: Effect.fn("JevvyPlugin.setup")(function*(ctx) {
    const permissionConfig = yield* loadJevvyConfig()

    if (permissionConfig.kind === "invalid") {
      yield* Effect.sync(() => {
        console.warn("[jevvy] jevvy.jsonc failed validation, auto-approval is disabled", permissionConfig.message)
      })
    }

    const ports = {
      activeIntegration: (id: string) => ctx.integration.connection.active(id),
      resolveIntegration: (connection: ConnectionInfo) => ctx.integration.connection.resolve(connection).pipe(
        Effect.map(storedCredentialFrom),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
      readEnv: (name: string) => process.env[name],
    }

    const apiKeys = permissionConfig.kind === "invalid" ? {} : permissionConfig.apiKeys
    const preference = permissionConfig.kind === "invalid" ? "auto" : permissionConfig.provider

    const selected = permissionConfig.kind === "invalid"
      ? undefined
      : yield* selectOpenCodeProvider(
        ports,
        preference,
        describeConnection,
        apiKeys,
        (): JevClient => ({
          evaluate: Effect.fn("JevvyPlugin.evaluateWithOpenCodeCredential")(function*(request) {
            const connection = yield* ctx.integration.connection.active(OPENCODE_INTEGRATION)

            const stored = connection === undefined
              ? undefined
              : yield* ctx.integration.connection.resolve(connection).pipe(
                Effect.map(storedCredentialFrom),
                Effect.catch(() => Effect.succeed(undefined)),
              )

            const token = credentialToken(stored)

            if (token === undefined) {
              return yield* new JevProviderError({
                provider: "zen",
                kind: "authentication",
                message: "OpenCode login is unavailable",
              })
            }

            return yield* createZenClient(token).evaluate(request)
          }),
        }),
      )

    const questions = permissionConfig.kind === "custom" ? permissionConfig.questions : undefined

    const reviewer = selected === undefined || permissionConfig.kind === "invalid"
      ? undefined
      : yield* createPermissionReviewer(selected.client, { questions }).pipe(Effect.orDie)

    if (selected === undefined && permissionConfig.kind !== "invalid") {
      yield* Effect.sync(() => {
        console.warn("[jevvy] no provider credential, native permission prompts remain unchanged")
      })
    }

    const evaluate = createEvaluate(reviewer, {
      report: (entry) => {
        if (entry.failure !== undefined) {
          console.warn("[jevvy] provider failure, native permission prompt remains unchanged", entry)

          return
        }

        console.info("[jevvy] permission review", entry)
      },
    })

    yield* ctx.permission.hook("evaluate", evaluate)

    yield* Effect.sync(() => {
      console.info("[jevvy] loaded", {
        provider: selected?.provider ?? "unavailable",
        model: selected?.model,
        questions: permissionConfig.kind === "custom" ? "custom" : "calibrated-defaults",
        autoApproval: reviewer === undefined ? "disabled" : "enabled",
      })
    })
  }),
})

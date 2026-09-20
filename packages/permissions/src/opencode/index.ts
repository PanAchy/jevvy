import { createTypeSafeClient, createZenClient, DEFAULT_TYPESAFE_MODEL, JevProviderError } from "../core.ts"
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
  resolveCredential,
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
    const provider = permissionConfig.kind === "invalid" ? "auto" : permissionConfig.provider
    const credential = yield* resolveCredential(ports, provider, describeConnection, apiKeys)

    let client: JevClient | undefined

    if (credential.kind === "typesafe") {
      client = createTypeSafeClient(credential.key)
    }

    if (credential.kind === "zen") {
      if (credential.origin === "opencode") {
        client = {
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

            return yield* createZenClient(token, credential.model).evaluate(request)
          }),
        }
      } else {
        client = createZenClient(credential.key, credential.model)
      }
    }

    const questions = permissionConfig.kind === "custom" ? permissionConfig.questions : undefined

    const reviewer = client === undefined || permissionConfig.kind === "invalid"
      ? undefined
      : yield* createPermissionReviewer(client, { questions }).pipe(Effect.orDie)

    if (client === undefined && permissionConfig.kind !== "invalid") {
      yield* Effect.sync(() => {
        console.warn("[jevvy] no provider credential, native permission prompts remain unchanged")
      })
    }

    const evaluate = createEvaluate(reviewer, {
      report: (entry) => console.info("[jevvy] permission review", entry),
    })

    yield* ctx.permission.hook("evaluate", evaluate)

    let model: string | undefined

    if (credential.kind === "zen") model = credential.model

    if (credential.kind === "typesafe") model = DEFAULT_TYPESAFE_MODEL

    yield* Effect.sync(() => {
      console.info("[jevvy] loaded", {
        provider: credential.kind,
        model,
        questions: permissionConfig.kind === "custom" ? "custom" : "calibrated-defaults",
        autoApproval: reviewer === undefined ? "disabled" : "enabled",
      })
    })
  }),
})

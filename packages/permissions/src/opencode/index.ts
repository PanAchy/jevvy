import { createZenClient, JevProviderError } from "../core.ts"
import type { JevClient } from "../core.ts"
import { Credential, Plugin } from "@opencode/plugin/effect"
import type { ConnectionInfo } from "@opencode/client"
import { Effect } from "effect"
import { globalJevvyConfigPath, loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import { createEvaluate } from "./evaluate.ts"
import {
  credentialToken,
  missingCredentialMessage,
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
    const configPath = globalJevvyConfigPath()
    const permissionConfig = yield* loadJevvyConfig(configPath)

    if (permissionConfig.kind === "invalid") {
      return yield* Effect.die(new Error(
        `Jevvy cannot start because ${configPath} is invalid: ${permissionConfig.message}. Fix the file, or move it aside and run "npx @jevvy/permissions init". OpenCode's remaining permission flow remains unchanged.`,
      ))
    }

    if (permissionConfig.kind === "unconfigured") {
      return yield* Effect.die(new Error(
        `Jevvy cannot start because no provider is configured. Run "npx @jevvy/permissions init" to create ${configPath}. OpenCode's remaining permission flow remains unchanged.`,
      ))
    }

    const ports = {
      activeIntegration: (id: string) => ctx.integration.connection.active(id),
      resolveIntegration: (connection: ConnectionInfo) => ctx.integration.connection.resolve(connection).pipe(
        Effect.map(storedCredentialFrom),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
      readEnv: (name: string) => process.env[name],
    }

    const selected = yield* selectOpenCodeProvider(
      ports,
      permissionConfig.selection,
      describeConnection,
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

    if (selected === undefined) {
      const provider = permissionConfig.selection.provider

      if (provider === "custom") {
        return yield* Effect.die(new Error("Jevvy could not construct the configured custom provider"))
      }

      return yield* Effect.die(new Error(missingCredentialMessage(provider, configPath)))
    }

    const questions = permissionConfig.kind === "custom-policy" ? permissionConfig.questions : undefined

    const reviewer = yield* createPermissionReviewer(selected.client, { questions }).pipe(Effect.orDie)

    const evaluate = createEvaluate(reviewer, {
      report: (entry) => {
        if (entry.failure !== undefined) {
          console.warn("[jevvy] provider failure, OpenCode's remaining permission flow is unchanged", entry)

          return
        }

        console.info("[jevvy] permission review", entry)
      },
    })

    yield* ctx.permission.hook("evaluate", evaluate)

    yield* Effect.sync(() => {
      console.info("[jevvy] loaded", {
        provider: selected.provider,
        model: selected.model,
        questions: permissionConfig.kind === "custom-policy"
          ? "custom"
          : selected.provider === "custom"
          ? "shipped-defaults-unverified"
          : "calibrated-defaults",
        autoApproval: "enabled",
      })
    })
  }),
})

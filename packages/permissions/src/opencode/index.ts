import { createTypeSafeClient, createZenClient, DEFAULT_TYPESAFE_MODEL } from "../core.ts"
import type { JevClient } from "../core.ts"
import { Credential, Plugin } from "@opencode/plugin"
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
  async setup(ctx) {
    const permissionConfig = await Effect.runPromise(loadJevvyConfig())

    if (permissionConfig.kind === "invalid") {
      console.warn("[jevvy] jevvy.jsonc failed validation, auto-approval is disabled", permissionConfig.message)
    }

    const ports = {
      activeIntegration: (id: string) => ctx.integration.connection.active(id),
      resolveIntegration: async (connection: ConnectionInfo) => {
        try {
          return storedCredentialFrom(await ctx.integration.connection.resolve(connection))
        } catch {
          return undefined
        }
      },
      readEnv: (name: string) => process.env[name],
    }

    const apiKeys = permissionConfig.kind === "invalid" ? {} : permissionConfig.apiKeys
    const provider = permissionConfig.kind === "invalid" ? "auto" : permissionConfig.provider
    const credential = await resolveCredential(ports, provider, describeConnection, apiKeys)

    let client: JevClient | undefined

    if (credential.kind === "typesafe") {
      client = createTypeSafeClient(credential.key)
    }

    if (credential.kind === "zen") {
      if (credential.origin === "opencode") {
        client = {
          async evaluate(request, signal) {
            const connection = await ctx.integration.connection.active(OPENCODE_INTEGRATION)

            const stored = connection === undefined
              ? undefined
              : storedCredentialFrom(await ctx.integration.connection.resolve(connection))

            const token = credentialToken(stored)

            if (token === undefined) throw new Error("OpenCode login is unavailable")

            return createZenClient(token, credential.model).evaluate(request, signal)
          },
        }
      } else {
        client = createZenClient(credential.key, credential.model)
      }
    }

    const questions = permissionConfig.kind === "custom" ? permissionConfig.questions : undefined

    const reviewer = client === undefined || permissionConfig.kind === "invalid"
      ? undefined
      : await createPermissionReviewer(client, { questions })

    if (client === undefined && permissionConfig.kind !== "invalid") {
      console.warn("[jevvy] no provider credential, native permission prompts remain unchanged")
    }

    const evaluate = createEvaluate(reviewer, {
      report: (entry) => console.info("[jevvy] permission review", entry),
    })

    const permissions = await ctx.permission.hook("evaluate", evaluate)

    let model: string | undefined

    if (credential.kind === "zen") model = credential.model

    if (credential.kind === "typesafe") model = DEFAULT_TYPESAFE_MODEL

    console.info("[jevvy] loaded", {
      provider: credential.kind,
      model,
      questions: permissionConfig.kind === "custom" ? "custom" : "calibrated-defaults",
      autoApproval: reviewer === undefined ? "disabled" : "enabled",
    })

    return async () => {
      await permissions.dispose()
      await reviewer?.dispose()
    }
  },
})

import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { globalJevvyConfigPath, loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import { createConfiguredProvider } from "../providers.ts"
import { createEvaluate } from "./evaluate.ts"
import { createCommandCapture } from "./command-capture.ts"
import { hasExplicitAsk } from "./ask-rule.ts"
import {
  missingConfigurationMessage,
  missingCredentialMessage,
} from "./setup.ts"

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
      return yield* Effect.die(new Error(missingConfigurationMessage(configPath)))
    }

    const selected = createConfiguredProvider(permissionConfig.selection)

    if (selected === undefined) {
      const provider = permissionConfig.selection.provider

      if (provider === "custom") {
        return yield* Effect.die(new Error("Jevvy could not construct the configured custom provider"))
      }

      return yield* Effect.die(new Error(missingCredentialMessage(provider, configPath)))
    }

    const questions = permissionConfig.kind === "custom-policy" ? permissionConfig.questions : undefined

    const reviewer = yield* createPermissionReviewer(selected.client, { questions }).pipe(Effect.orDie)
    const capture = createCommandCapture()

    yield* ctx.tool.hook("execute.before", capture.before)
    yield* ctx.shell.hook("create.before", capture.shellBefore)
    yield* ctx.tool.hook("execute.after", capture.after)

    const evaluate = createEvaluate(reviewer, {
      inspect: (event) => Effect.gen(function*() {
        const command = capture.commandFor(event)

        if (command === undefined) return undefined

        const session = yield* ctx.session.get({ sessionID: event.sessionID })
        const agentID = event.agent ?? session.agent

        if (agentID === undefined) return undefined

        const agent = yield* ctx.agent.get({ agentID, location: { directory: session.location.directory } })

        return {
          command,
          explicitAsk: hasExplicitAsk(event.action, event.resources, [
            ...agent.data.permissions,
            ...session.permissions ?? [],
          ]),
        }
      }).pipe(Effect.catch(() => Effect.succeed(undefined))),
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

import { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Schema } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { globalJevvyConfigPath, loadJevvyConfig } from "../config.ts"
import { createPermissionReviewer } from "../engine.ts"
import { createConfiguredProvider } from "../providers.ts"
import { createEvaluate } from "./evaluate.ts"
import { createCommandCapture } from "./command-capture.ts"
import { hasExplicitAsk } from "./ask-rule.ts"
import { createReviewControl } from "../review-control.ts"
import type { ReviewSnapshot } from "../review-control.ts"
import { JevvyControl } from "./rpc.ts"
import {
  invalidConfigurationMessage,
  missingConfigurationMessage,
  missingCredentialMessage,
} from "./setup.ts"

class PluginSetupError extends Schema.TaggedError<PluginSetupError>()("PluginSetupError", { message: Schema.String }) {}

export default Plugin.define({
  id: "jevvy.permissions",
  effect: Effect.fn("JevvyPlugin.setup")(function*(ctx) {
    const configPath = globalJevvyConfigPath()
    const control = yield* createReviewControl(configPath).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
    let problem: string | undefined

    const registration = yield* ctx.rpc.register(JevvyControl, {
      get: () => control.read("opencode").pipe(Effect.match({
        onFailure: () => ({ problem: problem ?? `Jevvy could not read ${configPath}. Run npx @jevvy/permissions init or fix the configuration.` }),
        onSuccess: (state) => problem === undefined ? state : { ...state, problem },
      })),
      toggle: (): Effect.Effect<ReviewSnapshot> => Effect.gen(function*() {
        const state = yield* control.change("opencode").pipe(Effect.orDie)
        yield* registration.events.emit("changed", state).pipe(Effect.orDie)

        return state
      }),
    }).pipe(Effect.orDie)

    yield* Effect.gen(function*() {
    const permissionConfig = yield* loadJevvyConfig(configPath)

    if (permissionConfig.kind === "invalid") {
      return yield* new PluginSetupError({ message: invalidConfigurationMessage(configPath, permissionConfig.message) })
    }

    if (permissionConfig.kind === "unconfigured") {
      return yield* new PluginSetupError({ message: missingConfigurationMessage(configPath) })
    }

    const selected = createConfiguredProvider(permissionConfig.selection)

    if (selected === undefined) {
      const provider = permissionConfig.selection.provider

      if (provider === "custom") {
        return yield* new PluginSetupError({ message: "Jevvy could not construct the configured custom provider" })
      }

      return yield* new PluginSetupError({ message: missingCredentialMessage(provider, configPath) })
    }

    const questions = permissionConfig.kind === "custom-policy" ? permissionConfig.questions : undefined

    const reviewer = yield* createPermissionReviewer(selected.client, { questions }).pipe(Effect.orDie)
    const capture = createCommandCapture()

    yield* ctx.tool.hook("execute.before", capture.before)
    yield* ctx.shell.hook("create.before", capture.shellBefore)
    yield* ctx.tool.hook("execute.after", capture.after)

    const evaluate = createEvaluate(reviewer, {
      control,
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
    }).pipe(Effect.catchTag("PluginSetupError", (error) => Effect.sync(() => {
      problem = error.message
      console.warn(problem)
    })))
  }),
})

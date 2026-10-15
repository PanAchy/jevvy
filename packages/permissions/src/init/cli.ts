import * as Effect from "effect/Effect"
import * as Terminal from "effect/Terminal"
import * as Command from "effect/cli/Command"
import type * as Prompt from "effect/cli/Prompt"
import { globalJevvyConfigPath } from "../config.ts"
import { initializeJevvy, InitPlatform } from "./index.ts"
import type { InitPlan, InitResult } from "./index.ts"
import {
  promptInitPlan,
  showInitError,
  showInitProgress,
  showInitResult,
  showInitCancelled,
} from "./prompt.ts"

export interface InitFrontend<R = never> {
  readonly prompt: (configPath: string, existing: string | undefined) => Effect.Effect<InitPlan | undefined, Terminal.QuitError, R>
  readonly showProgress: Effect.Effect<void, never, R>
  readonly showError: (message: string) => Effect.Effect<void, never, R>
  readonly showResult: (result: InitResult) => Effect.Effect<void, never, R>
  readonly showCancelled: Effect.Effect<void, never, R>
}

const terminalFrontend: InitFrontend<Prompt.Environment> = {
  prompt: promptInitPlan,
  showProgress: showInitProgress,
  showError: showInitError,
  showResult: showInitResult,
  showCancelled: showInitCancelled,
}

export const executeInit = Effect.fn("InitCli.execute")(function*<R>(
  frontend: InitFrontend<R>,
  configPath: string,
) {
  const platform = yield* InitPlatform
  const existing = yield* platform.readConfig(configPath)

  const plan = yield* frontend.prompt(configPath, existing)

  if (plan === undefined) return 0

  yield* frontend.showProgress

  const result = yield* initializeJevvy(plan, configPath)

  yield* frontend.showResult(result)

  return 0
}, (effect, frontend) => effect.pipe(
  Effect.catchTag("QuitError", () => frontend.showCancelled.pipe(Effect.as(0))),
  Effect.catch((error) => frontend.showError(error.message).pipe(Effect.as(1))),
))

const runInit = Effect.fn("InitCli.run")(function*() {
  const code = yield* executeInit(terminalFrontend, globalJevvyConfigPath())

  if (code !== 0) process.exitCode = code
})

const initCommand = Command.make("init", {}, runInit).pipe(
  Command.withDescription("Configure Jevvy Permissions and install it in selected agent harnesses"),
)

export const jevvyCommand = Command.make("jevvy").pipe(
  Command.withDescription("Configure Jevvy Permissions"),
  Command.withSubcommands([initCommand]),
)

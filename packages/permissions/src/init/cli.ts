import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { globalJevvyConfigPath } from "../config.ts"
import { initializeJevvy } from "./index.ts"
import type { InitPlan, InitResult } from "./index.ts"
import {
  promptInitPlan,
  showInitError,
  showInitProgress,
  showInitResult,
} from "./prompt.ts"

class InitPromptError extends Schema.TaggedError<InitPromptError>()("InitPromptError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface InitFrontend {
  readonly prompt: (configPath: string) => Promise<InitPlan | undefined>
  readonly showProgress: () => void
  readonly showError: (message: string) => void
  readonly showResult: (result: InitResult) => void
}

const clackFrontend: InitFrontend = {
  prompt: promptInitPlan,
  showProgress: showInitProgress,
  showError: showInitError,
  showResult: showInitResult,
}

export const executeInit = Effect.fn("InitCli.execute")(function*(
  frontend: InitFrontend,
  configPath: string,
) {
  const plan = yield* Effect.tryPromise({
    try: () => frontend.prompt(configPath),
    catch: (cause) => new InitPromptError({ message: "Interactive setup failed", cause }),
  })

  if (plan === undefined) return 0

  yield* Effect.sync(frontend.showProgress)

  const result = yield* initializeJevvy(plan, configPath)

  yield* Effect.sync(() => frontend.showResult(result))

  return 0
}, (effect, frontend) => effect.pipe(
  Effect.catch((error) => Effect.sync(() => {
    frontend.showError(error.message)

    return 1
  })),
))

const runInit = Effect.fn("InitCli.run")(function*() {
  const code = yield* executeInit(clackFrontend, globalJevvyConfigPath())

  if (code !== 0) process.exitCode = code
})

const initCommand = Command.make("init", {}, runInit).pipe(
  Command.withDescription("Configure Jevvy and install it in selected agent harnesses"),
)

export const jevvyCommand = Command.make("jevvy").pipe(
  Command.withDescription("Configure Jevvy permission review"),
  Command.withSubcommands([initCommand]),
)

#!/usr/bin/env node

import * as Effect from "effect/Effect"
import { NodeServices } from "@effect/platform-node"
import { createClaudeHookHandler, loadClaudeSetup } from "./hook.ts"
import { globalJevvyConfigPath } from "../config.ts"
import { createReviewControl } from "../review-control.ts"
import { loadAskRules } from "./ask-rules.ts"

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8")

  let input = ""

  for await (const chunk of process.stdin) input += chunk

  return input
}

const run = async (): Promise<void> => {
  try {
    const raw = await readStdin()

    const output = await Effect.runPromise(Effect.gen(function*() {
      const control = yield* createReviewControl(globalJevvyConfigPath())
      const handle = createClaudeHookHandler(() => loadClaudeSetup(), loadAskRules, control)

      return yield* handle(raw)
    }).pipe(Effect.provide(NodeServices.layer)))

    if (output !== undefined) process.stdout.write(JSON.stringify(output))
  } catch {
  }
}

void run()

#!/usr/bin/env node

import { Effect, Layer } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { createClaudeHookHandler, loadClaudeSetup } from "./hook.ts"
import { globalJevvyConfigPath } from "../config.ts"
import { createReviewControl } from "../review-control.ts"

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8")

  let input = ""

  for await (const chunk of process.stdin) input += chunk

  return input
}

const run = async (): Promise<void> => {
  try {
    const control = await Effect.runPromise(createReviewControl(globalJevvyConfigPath()).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))))
    const handle = createClaudeHookHandler(() => loadClaudeSetup(), undefined, control)
    const output = await Effect.runPromise(handle(await readStdin()))

    if (output !== undefined) process.stdout.write(JSON.stringify(output))
  } catch {
  }
}

void run()

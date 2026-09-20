#!/usr/bin/env node

import { Effect } from "effect"
import { createClaudeHookHandler, loadClaudeSetup } from "./hook.ts"

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8")

  let input = ""

  for await (const chunk of process.stdin) input += chunk

  return input
}

const run = async (): Promise<void> => {
  try {
    const handle = createClaudeHookHandler(() => loadClaudeSetup())
    const output = await Effect.runPromise(handle(await readStdin()))

    if (output !== undefined) process.stdout.write(output)
  } catch {
    // Process failures are abstentions. Keep both output streams empty.
  }
}

void run()

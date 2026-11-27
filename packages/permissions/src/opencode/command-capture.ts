import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { Effect, Option, Schema } from "effect"

const ShellInput = Schema.Struct({ command: Schema.NonEmptyString })

const decodeShellInput = Schema.decodeUnknownOption(ShellInput)

const MAX_ACTIVE = 512

interface ToolEvent {
  readonly tool: string
  readonly sessionID: string
  readonly messageID: string
  readonly id: string
  readonly input?: unknown
}

interface PermissionEvent {
  readonly sessionID: string
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string }
}

interface ActiveCommand {
  readonly event: ToolEvent
  invocation?: ShellCreateBefore
  count: number
  ambiguous: boolean
}

const keyOf = (sessionID: string, messageID: string, id: string): string =>
  JSON.stringify([sessionID, messageID, id])

const commandOf = (input: unknown): string | undefined => {
  const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined

  return typeof command === "string" && command.trim().length > 0 ? command : undefined
}

export const createCommandCapture = () => {
  const active = new Map<string, ActiveCommand>()

  return {
    before: Effect.fn("OpenCode.captureShellTool")(function*(event: ToolEvent) {
      if (event.tool !== "shell") return

      const key = keyOf(event.sessionID, event.messageID, event.id)
      const current = active.get(key)

      if (current === undefined) {
        if (active.size >= MAX_ACTIVE) {
          const oldest = active.keys().next().value

          if (oldest !== undefined) active.delete(oldest)
        }

        active.set(key, { event, count: 1, ambiguous: false })
      } else {
        current.count += 1
        current.ambiguous = true
      }
    }),
    shellBefore: Effect.fn("OpenCode.captureShellInvocation")(function*(invocation: ShellCreateBefore) {
      const command = commandOf(invocation)

      if (command === undefined) return

      const matches = [...active.values()].filter((entry) => commandOf(entry.event.input) === command)

      if (matches.length !== 1) {
        for (const entry of matches) entry.ambiguous = true

        return
      }

      const [current] = matches

      if (current.invocation !== undefined) {
        current.ambiguous = true

        return
      }

      // Keep the mutable host invocation, not a snapshot. Later shell hooks
      // finish before the host scans this same object for permissions.
      current.invocation = invocation
    }),
    after: Effect.fn("OpenCode.releaseShellTool")(function*(event: ToolEvent) {
      if (event.tool !== "shell") return

      const key = keyOf(event.sessionID, event.messageID, event.id)
      const current = active.get(key)

      if (current === undefined) return

      current.count -= 1

      if (current.count === 0) active.delete(key)
    }),
    commandFor(event: PermissionEvent): string | undefined {
      if (event.source?.type !== "tool") return undefined

      const current = active.get(keyOf(event.sessionID, event.source.messageID, event.source.id))
      const command = current?.invocation && Option.getOrUndefined(decodeShellInput(current.invocation))?.command

      return current?.ambiguous === false && command?.trim().length ? command : undefined
    },
  }
}

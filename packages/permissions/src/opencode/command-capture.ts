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
}

interface PermissionEvent {
  readonly sessionID: string
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string }
}

interface ActiveCommand {
  invocation?: ShellCreateBefore
  count: number
  ambiguous: boolean
}

const keyOf = (sessionID: string, messageID: string, id: string): string =>
  JSON.stringify([sessionID, messageID, id])

export const createCommandCapture = () => {
  const active = new Map<string, ActiveCommand>()
  const callsByFiber = new WeakMap<object, string[]>()

  return {
    before: Effect.fn("OpenCode.captureShellTool")(function*(event: ToolEvent) {
      if (event.tool !== "shell") return

      const fiber = yield* Effect.fiber
      const key = keyOf(event.sessionID, event.messageID, event.id)
      const current = active.get(key)

      if (current === undefined) {
        if (active.size >= MAX_ACTIVE) {
          const oldest = active.keys().next().value

          if (oldest !== undefined) active.delete(oldest)
        }

        active.set(key, { count: 1, ambiguous: false })
      } else {
        current.count += 1
        current.ambiguous = true
      }

      const calls = callsByFiber.get(fiber) ?? []
      calls.push(key)
      callsByFiber.set(fiber, calls)
    }),
    shellBefore: Effect.fn("OpenCode.captureShellInvocation")(function*(invocation: ShellCreateBefore) {
      const calls = callsByFiber.get(yield* Effect.fiber)
      const key = calls?.at(-1)
      const current = key === undefined ? undefined : active.get(key)

      if (current === undefined) return

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
      const fiber = yield* Effect.fiber
      const calls = callsByFiber.get(fiber)

      if (calls !== undefined) {
        const index = calls.lastIndexOf(key)

        if (index !== -1) calls.splice(index, 1)

        if (calls.length === 0) callsByFiber.delete(fiber)
      }

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

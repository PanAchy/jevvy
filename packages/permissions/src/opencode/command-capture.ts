import { Option, Schema } from "effect"

const ShellInput = Schema.Struct({ command: Schema.NonEmptyString })

const decodeShellInput = Schema.decodeUnknownOption(ShellInput)

const MAX_ACTIVE = 512

interface ToolEvent {
  readonly tool: string
  readonly sessionID: string
  readonly messageID: string
  readonly id: string
  readonly input: unknown
}

interface PermissionEvent {
  readonly sessionID: string
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string }
}

interface ActiveCommand {
  readonly command: string
  count: number
  ambiguous: boolean
}

const keyOf = (sessionID: string, messageID: string, id: string): string =>
  JSON.stringify([sessionID, messageID, id])

export const createCommandCapture = () => {
  const active = new Map<string, ActiveCommand>()

  return {
    before(event: ToolEvent): void {
      if (event.tool !== "shell") return

      const input = Option.getOrUndefined(decodeShellInput(event.input))

      if (input === undefined || input.command.trim().length === 0) return

      const key = keyOf(event.sessionID, event.messageID, event.id)
      const current = active.get(key)

      if (current === undefined) {
        if (active.size >= MAX_ACTIVE) {
          const oldest = active.keys().next().value

          if (oldest !== undefined) active.delete(oldest)
        }

        active.set(key, { command: input.command, count: 1, ambiguous: false })

        return
      }

      current.count += 1
      current.ambiguous = true
    },
    after(event: ToolEvent): void {
      if (event.tool !== "shell") return

      const key = keyOf(event.sessionID, event.messageID, event.id)
      const current = active.get(key)

      if (current === undefined) return

      current.count -= 1

      if (current.count === 0) active.delete(key)
    },
    commandFor(event: PermissionEvent): string | undefined {
      if (event.source?.type !== "tool") return undefined

      const current = active.get(keyOf(event.sessionID, event.source.messageID, event.source.id))

      return current?.ambiguous === false ? current.command : undefined
    },
  }
}

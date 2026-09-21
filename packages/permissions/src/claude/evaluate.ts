import { Effect, Option, Schema } from "effect"
import type { PermissionReviewer } from "../engine.ts"

const PermissionMode = Schema.Literals([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
])

const BashInput = Schema.Struct({
  command: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Schema.Number),
  run_in_background: Schema.optionalKey(Schema.Boolean),
})

const ClaudePermissionRequest = Schema.Struct({
  session_id: Schema.String,
  prompt_id: Schema.String,
  transcript_path: Schema.String,
  cwd: Schema.String,
  scratchpad_dir: Schema.optionalKey(Schema.String),
  permission_mode: PermissionMode,
  hook_event_name: Schema.Literals(["PermissionRequest"]),
  tool_name: Schema.Literals(["Bash"]),
  tool_input: BashInput,
})

const ClaudeSessionStart = Schema.Struct({
  session_id: Schema.String,
  prompt_id: Schema.optionalKey(Schema.String),
  transcript_path: Schema.String,
  cwd: Schema.String,
  scratchpad_dir: Schema.optionalKey(Schema.String),
  hook_event_name: Schema.Literals(["SessionStart"]),
  source: Schema.Literals(["startup", "resume", "clear", "compact", "fork"]),
  model: Schema.optionalKey(Schema.String),
  agent_type: Schema.optionalKey(Schema.String),
  session_title: Schema.optionalKey(Schema.String),
})

const ClaudeHookEventJson = Schema.fromJsonString(Schema.Union([
  ClaudePermissionRequest,
  ClaudeSessionStart,
]))

interface ClaudePermissionRequest extends Schema.Schema.Type<typeof ClaudePermissionRequest> {}

export type ClaudeHookEvent = Schema.Schema.Type<typeof ClaudeHookEventJson>

export const permissionAllowOutput = {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "allow",
    },
  },
} as const

export type PermissionAllowOutput = typeof permissionAllowOutput

export const setupUnavailableOutput = (message: string) => ({ systemMessage: message }) as const

export const decodeClaudeHookEvent = (raw: string): ClaudeHookEvent | undefined =>
  Schema.decodeUnknownOption(ClaudeHookEventJson)(raw).pipe(
    Option.filter((event) =>
      event.hook_event_name !== "PermissionRequest" || event.tool_input.command.trim().length > 0),
    Option.getOrUndefined,
  )

export const createClaudeEvaluate = (
  reviewer: PermissionReviewer,
): ((request: ClaudePermissionRequest) => Effect.Effect<PermissionAllowOutput | undefined>) =>
  Effect.fn("ClaudeCode.evaluatePermissionRequest")(function*(request) {
    const review = yield* reviewer.review({
      action: "shell",
      resources: [request.tool_input.command],
    })

    return review.effect === "allow" ? permissionAllowOutput : undefined
  })

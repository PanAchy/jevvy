import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Option from "effect/Option"
import { preflightHistoryStore } from "../history/history-files.ts"
import type { HistoryStorageError } from "../history.ts"

const historySetupMessage = (problem: HistoryStorageError): string | undefined => {
  if (problem.kind === "unsupported-platform") return "Jevvy Permissions review history is unavailable on Windows because user-only ACLs cannot be verified. Set metrics.enabled to false to disable history. Permission reviews are unchanged."

  if (problem.kind === "unsafe-path") return "Jevvy Permissions review history is unavailable because an existing global configuration or metrics path is not private. Check directory ownership and mode 0700, file ownership and mode 0600, and remove symlinks or hardlinks from the history paths, or set metrics.enabled to false. Permission reviews are unchanged."

  if (problem.kind === "unsupported-schema") return "Jevvy Permissions review history is unavailable because the private global metrics directory contains unsupported entries. Check the existing history directory contents without modifying active database files, or set metrics.enabled to false. Permission reviews are unchanged."

  return undefined
}

export const checkClaudeHistorySetup = Effect.fn("ClaudeCode.checkHistorySetup")(function*(
  configuration: { readonly configPath: string },
  preflight: (configPath: string) => Effect.Effect<void, HistoryStorageError> = preflightHistoryStore,
) {
  return yield* Effect.suspend(() => preflight(configuration.configPath)).pipe(
    Effect.match({ onFailure: historySetupMessage, onSuccess: () => undefined }),
    Effect.timeoutOption("500 millis"),
    Effect.map(Option.getOrUndefined),
    Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => Effect.succeed(undefined)),
  )
})

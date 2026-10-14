import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import type { InitHarness } from "./index.ts"
import { harnessCommand } from "./harness-command.ts"

export class PreflightError extends Schema.TaggedError<PreflightError>()("PreflightError", { message: Schema.String }) {}

const StableVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))

const decodeVersion = Schema.decodeUnknownOption(StableVersion)

const VersionNumber = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

const decodeVersionParts = Schema.decodeUnknownOption(Schema.Tuple([VersionNumber, VersionNumber, VersionNumber]))

export const opencodeCompatibilityWarning = (output: string): string | undefined => {
  const decoded = decodeVersion(output.trim())

  if (Option.isNone(decoded)) {
    return [
      "Could not verify the OpenCode CLI version. The OpenCode integration requires 2.0.27 or newer starting in Jevvy Permissions 0.6.0.",
      "This checks the CLI on PATH, not a separate desktop app or remote server.",
    ].join("\n")
  }

  const parts = decodeVersionParts(decoded.value.split(".").map(Number))

  if (Option.isNone(parts)) return opencodeCompatibilityWarning("")
  const [major, minor, patch] = parts.value

  if (major > 2 || major === 2 && (minor > 0 || patch >= 27)) return undefined

  return [
    `Detected OpenCode ${decoded.value}.`,
    "Starting in 0.6.0, the OpenCode integration in Jevvy Permissions requires OpenCode 2.0.27 or newer.",
    "Upgrade OpenCode, then run setup again.",
    ...(major === 2 ? ["To stay on this OpenCode version: opencode plugin add @jevvy/permissions@0.5.1"] : []),
    "This checks the CLI on PATH, not a separate desktop app or remote server.",
  ].join("\n")
}

export const inspectHarness = Effect.fn("Init.inspectHarness")(function*(harness: InitHarness) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const output = yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(harnessCommand(harness, ["--version"])).pipe(
      Effect.mapError(() => new PreflightError({ message: harness === "opencode"
        ? "Could not start the opencode command. Automatic setup requires the OpenCode CLI on PATH. Install the CLI, or add @jevvy/permissions to your OpenCode configuration manually. Your Jevvy configuration was not changed."
        : "Could not start the claude command. Install the Claude Code CLI or use manual plugin setup. Your Jevvy configuration was not changed." })),
    )

    return yield* Effect.all({
      code: handle.exitCode, stdout: Stream.mkString(Stream.decodeText(handle.stdout)), stderr: Stream.runDrain(handle.stderr),
    }, { concurrency: "unbounded" })
  })).pipe(Effect.timeout(5000), Effect.catchIf((error) => !(error instanceof PreflightError), () => Effect.void))

  if (output !== undefined && output.code !== 0) {
    return yield* new PreflightError({ message: `${harness} --version exited with code ${output.code}. Automatic setup requires the selected CLI on PATH. Check that ${harness} --version works, then run setup again. Your Jevvy configuration was not changed.` })
  }

  if (harness === "claude") {
    if (output === undefined) return yield* new PreflightError({ message: "Could not verify the Claude Code CLI. Check that claude --version works, then run setup again. Your Jevvy configuration was not changed." })

    return undefined
  }

  return opencodeCompatibilityWarning(output?.stdout ?? "")
})

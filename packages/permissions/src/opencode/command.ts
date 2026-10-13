import type { Plugin } from "@opencode/plugin/effect"
import type { CommandInvocation } from "@opencode/plugin/effect/command"
import { Effect, Schema } from "effect"
import type { ReviewControlError, ReviewSnapshot } from "../review-control.ts"

export class ReviewCommandError extends Schema.TaggedError<ReviewCommandError>()("ReviewCommandError", {
  message: Schema.String,
}) {}

export const createReviewCommand = (
  toggle: Effect.Effect<ReviewSnapshot, ReviewControlError>,
  session: Pick<Plugin.Context["session"], "synthetic">,
  problem: () => string | undefined,
) => ({
  name: "jevvy",
  description: "Toggle Jevvy auto-review globally",
  execute: Effect.fn("JevvyCommand.execute")(function*(input: CommandInvocation) {
    const state = yield* toggle.pipe(Effect.mapError(() => new ReviewCommandError({
      message: "Could not update Jevvy's global configuration. Check that it is writable and try again.",
    })))

    const description = `Jevvy ${state.enabled ? "enabled" : "disabled"}`
    const diagnostic = state.enabled ? problem() : undefined
    yield* session.synthetic({
      sessionID: input.sessionID,
      text: diagnostic === undefined ? `${description}.` : `${description}. ${diagnostic}`,
      description: diagnostic === undefined ? description : `${description}. ${diagnostic}`,
      resume: false,
    }).pipe(Effect.mapError(() => new ReviewCommandError({
      message: `${description}, but OpenCode could not record the confirmation. Do not repeat /jevvy unless you want to toggle again.`,
    })))
  }),
})

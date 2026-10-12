import { describe, expect, it } from "@effect/vitest"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect } from "effect"
import { createReviewCommand } from "../src/opencode/command.ts"
import { ReviewControlError } from "../src/review-control.ts"

const invocation = {
  sessionID: Session.ID.make("ses_control"),
  prompt: { text: "" },
  delivery: "steer" as const,
}

describe("OpenCode review command", () => {
  for (const enabled of [true, false]) {
    it.effect(`confirms ${enabled ? "enabled" : "disabled"} without waking the model`, () => Effect.gen(function*() {
      const notices: object[] = []

      const command = createReviewCommand(Effect.succeed({ enabled }), {
        synthetic: (input) => Effect.sync(() => {
          notices.push(input)

          return SessionInbox.Synthetic.make({
            id: SessionMessage.ID.make("msg_control"),
            sessionID: input.sessionID,
            type: "synthetic",
            delivery: "steer",
            payload: { text: input.text },
            time: { created: DateTime.makeUnsafe(0) },
          })
        }),
      }, () => undefined)

      expect(command.name).toBe("jevvy")
      yield* command.execute(invocation)
      expect(notices).toEqual([{
        sessionID: invocation.sessionID,
        text: `Jevvy ${enabled ? "enabled" : "disabled"}.`,
        description: `Jevvy ${enabled ? "enabled" : "disabled"}`,
        resume: false,
      }])
    }))
  }

  it.effect("does not publish a success notice when persistence fails", () => Effect.gen(function*() {
    const command = createReviewCommand(Effect.fail(new ReviewControlError({ operation: "write" })), {
      synthetic: () => Effect.die("Confirmation must not run"),
    }, () => undefined)

    expect(yield* command.execute(invocation).pipe(Effect.flip)).toMatchObject({
      message: "Could not update Jevvy's global configuration. Check that it is writable and try again.",
    })
  }))

  it.effect("distinguishes a persisted toggle from a failed confirmation", () => Effect.gen(function*() {
    const command = createReviewCommand(Effect.succeed({ enabled: false }), {
      synthetic: () => Effect.fail("unavailable"),
    }, () => undefined)

    expect(yield* command.execute(invocation).pipe(Effect.flip)).toMatchObject({
      message: "Jevvy disabled, but OpenCode could not record the confirmation. Do not repeat /jevvy unless you want to toggle again.",
    })
  }))

  it.effect("includes setup diagnostics when enabling an unavailable reviewer", () => Effect.gen(function*() {
    const command = createReviewCommand(Effect.succeed({ enabled: true }), {
      synthetic: (input) => {
        expect(input.description).toBe("Jevvy enabled. Configure a provider first.")
        expect(input.resume).toBe(false)

        return Effect.fail("recording checked")
      },
    }, () => "Configure a provider first.")

    yield* command.execute(invocation).pipe(Effect.flip)
  }))
})

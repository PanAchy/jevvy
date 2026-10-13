import { Clock, Duration, Effect, Layer, ManagedRuntime, Scheduler, Schema } from "effect"
import { ReviewPresentation, ReviewPresentationError } from "../review-presentation.ts"
import { ReviewSnapshot } from "../review-state.ts"

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewSnapshot))

const runOptions = { scheduler: new Scheduler.MixedScheduler("sync") }

const dispose = (runtime) => runtime === undefined ? Promise.resolve() : Effect.runPromise(runtime.disposeEffect, runOptions)

async function control($, operation) {
  const result = await $.process.run(["node", `${$.plugin.root}/dist/claude-control.js`, operation], { timeoutMs: 5000 })

  if (result.exitCode !== 0) throw new Error("Jevvy control is unavailable")

  return decodeState(result.stdout)
}

function nativeClock($) {
  const base = Clock.Clock.defaultValue()

  return {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: base.currentTimeMillis,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => {
      const milliseconds = Duration.toMillis(duration)

      if (milliseconds <= 0) return Effect.yieldNow

      if (!Number.isFinite(milliseconds)) return Effect.never

      return Effect.callback((resume) => {
        const timer = $.clock.after(milliseconds, () => resume(Effect.void))

        return Effect.sync(() => timer.cancel())
      })
    },
  }
}

export function register(on) {
  let state = { enabled: undefined, dimmed: false }
  let runtime

  on("session.start", async ($, event, next) => {
    const previous = runtime

    const current = ManagedRuntime.make(ReviewPresentation.layer({
      read: Effect.tryPromise({
        try: () => control($, "read"),
        catch: () => new ReviewPresentationError({ message: "Could not read Jevvy's global configuration. Run npx @jevvy/permissions init or fix the configuration." }),
      }),
      toggle: Effect.tryPromise({
        try: () => control($, "toggle"),
        catch: () => new ReviewPresentationError({ message: "Could not update Jevvy's global configuration. Check that it is writable and try again." }),
      }),
      render: (value) => {
        state = value
        $.ui.invalidate("ui.render")
      },
      report: (message) => $.ui.toast(message),
    }).pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, nativeClock($)))))

    runtime = current
    await dispose(previous)

    if (runtime !== current) return next(event)
    await current.runPromise(ReviewPresentation, runOptions)

    if (runtime !== current) return next(event)
    await $.command.register({ name: "jevvy", description: "Toggle Jevvy", immediate: true })

    return next(event)
  })
  on("command.run", { command: "jevvy" }, async () => {
    const current = runtime

    if (current !== undefined) await current.runPromise(Effect.gen(function*() {
      const presentation = yield* ReviewPresentation
      yield* presentation.toggle
    }), runOptions)

    return {}
  })
  on("ui.render", { component: "SessionMode", surface: "terminal" }, async ($, event, next) => {
    const original = await next(event)
    const enabled = state.enabled
    const badge = h("Text", { color: enabled === undefined ? "gray" : enabled ? "green" : "red", dimColor: state.dimmed }, "Jevvy")

    return h("Box", { gap: 1 }, original, badge)
  })
  on("session.end", async ($, event, next) => {
    const previous = runtime
    runtime = undefined
    await dispose(previous)

    return next(event)
  })
}

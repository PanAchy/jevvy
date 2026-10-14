import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"

export const resizeEvents = Effect.gen(function*() {
  const events = yield* Queue.make<void>()
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const notify = () => Queue.offerUnsafe(events, undefined)
      process.stdout.on("resize", notify)

      return notify
    }),
    (notify) => Effect.sync(() => { process.stdout.off("resize", notify) }),
  )

  return events
}).pipe(Effect.withSpan("Init.resizeEvents"))

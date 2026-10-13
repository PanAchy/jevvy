import { Clock, Duration, Effect, FiberMap, Schedule } from "effect"

export interface ReviewIndicatorState {
  readonly enabled: boolean | undefined
  readonly dimmed: boolean
}

export const createReviewIndicator = Effect.fn("ReviewIndicator.create")(function*(render: (state: ReviewIndicatorState) => void) {
  const clock = yield* Clock.Clock
  const pulses = yield* FiberMap.make<"pulse", void, never>()
  let enabled: boolean | undefined
  let disposed = false
  render({ enabled: undefined, dimmed: false })
  yield* Effect.addFinalizer(() => Effect.sync(() => { disposed = true }))

  const update = Effect.fn("ReviewIndicator.update")(function*(next: boolean | undefined) {
    if (disposed || next === enabled) return
    const previous = enabled
    enabled = next
    yield* FiberMap.remove(pulses, "pulse")

    if (disposed) return
    render({ enabled, dimmed: false })

    if (previous === undefined || next === undefined) return

    let ticks = 0

    const blink = Effect.gen(function*() {
      yield* clock.sleep(Duration.millis(250))
      ticks++

      if (!disposed) render({ enabled, dimmed: ticks < 4 && ticks % 2 === 1 })
    }).pipe(Effect.repeat(Schedule.recurs(3)), Effect.asVoid)

    yield* FiberMap.run(pulses, "pulse", blink)
  })

  return { update }
})

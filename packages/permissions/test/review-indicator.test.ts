import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import { createReviewIndicator } from "../src/review-indicator.ts"
import type { ReviewIndicatorState } from "../src/review-indicator.ts"

const makeDisplay = Effect.fn("Test.makeIndicator")(function*() {
  const frames: ReviewIndicatorState[] = []
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const indicator = yield* createReviewIndicator((state) => { frames.push(state) }).pipe(Scope.provide(scope))

  return { indicator, frames, dispose: Scope.close(scope, Exit.void) }
})

describe("review indicator", () => {
  it.effect("renders unknown then the initial state without blinking", () => Effect.gen(function*() {
    const display = yield* makeDisplay()
    yield* display.indicator.update(true)
    expect(display.frames).toEqual([{ enabled: undefined, dimmed: false }, { enabled: true, dimmed: false }])
    yield* TestClock.adjust("1 second")
    expect(display.frames).toHaveLength(2)
  }))

  it.effect("blinks both changes for exactly four 250ms ticks", () => Effect.gen(function*() {
    const display = yield* makeDisplay()
    yield* display.indicator.update(true)

    for (const enabled of [false, true]) {
      const before = display.frames.length
      yield* display.indicator.update(enabled)
      yield* TestClock.adjust("1 second")
      expect(display.frames.slice(before).map((frame) => frame.dimmed)).toEqual([false, true, false, true, false])
      expect(display.frames.at(-1)).toEqual({ enabled, dimmed: false })
      yield* TestClock.adjust("1 second")
      expect(display.frames.length - before).toBe(5)
    }
  }))

  it.effect("ignores an unchanged poll without extending an active pulse", () => Effect.gen(function*() {
    const display = yield* makeDisplay()
    yield* display.indicator.update(true)
    yield* display.indicator.update(false)
    yield* TestClock.adjust("250 millis")
    yield* display.indicator.update(false)
    yield* TestClock.adjust("750 millis")
    const count = display.frames.length
    yield* TestClock.adjust("1 second")
    expect(display.frames.length).toBe(count)
    expect(display.frames.at(-1)?.dimmed).toBe(false)
  }))

  it.effect("ignores late updates after scope disposal without creating fibers", () => Effect.gen(function*() {
    const display = yield* makeDisplay()
    yield* display.indicator.update(true)
    yield* display.indicator.update(false)
    yield* display.dispose
    const count = display.frames.length
    yield* display.indicator.update(true)
    yield* TestClock.adjust("1 second")
    expect(display.frames.length).toBe(count)
  }))

  it.effect("interrupts animation when persisted state becomes unavailable", () => Effect.gen(function*() {
    const display = yield* makeDisplay()
    yield* display.indicator.update(true)
    yield* display.indicator.update(false)
    yield* display.indicator.update(undefined)
    expect(display.frames.at(-1)).toEqual({ enabled: undefined, dimmed: false })
    const count = display.frames.length
    yield* TestClock.adjust("1 second")
    expect(display.frames.length).toBe(count)
  }))
})

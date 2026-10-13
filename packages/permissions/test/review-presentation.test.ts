import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ReviewPresentation, ReviewPresentationError } from "../src/review-presentation.ts"
import type { ReviewPresentationHost, ReviewStatus } from "../src/review-presentation.ts"
import type { ReviewIndicatorState } from "../src/review-indicator.ts"

const makeDisplay = Effect.fn("Test.makeDisplay")(function*(read: ReviewPresentationHost["read"], toggle: ReviewPresentationHost["toggle"]) {
  const frames: ReviewIndicatorState[] = []
  const reports: string[] = []
  const rendered = yield* Queue.unbounded<ReviewIndicatorState>()
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

  const context = yield* Layer.buildWithScope(ReviewPresentation.layer({
    read,
    toggle,
    render: (state) => {
      frames.push(state)

      if (frames.length > 1) Queue.offerUnsafe(rendered, state)
    },
    report: (message) => { reports.push(message) },
  }), scope)

  return { presentation: Context.get(context, ReviewPresentation), frames, reports, rendered, dispose: Scope.close(scope, Exit.void) }
})

describe("native review presentation", () => {
  it.effect("keeps controls available while initial loading is pending and skips overlapping reads", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const pending = yield* Deferred.make<ReviewStatus>()
    let reads = 0

    const display = yield* makeDisplay(Effect.gen(function*() {
      reads++
      yield* Deferred.succeed(entered, undefined)

      return yield* Deferred.await(pending)
    }), Effect.succeed({ enabled: false }))

    yield* Deferred.await(entered)
    yield* display.presentation.refresh
    yield* display.presentation.refresh
    expect(reads).toBe(1)
    yield* Deferred.succeed(pending, { enabled: true })
    expect(yield* Queue.take(display.rendered)).toEqual({ enabled: true, dimmed: false })
  }))

  it.effect("serializes a toggle after a pending read so an old read cannot overwrite it", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const pending = yield* Deferred.make<ReviewStatus>()

    const display = yield* makeDisplay(Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)

      return yield* Deferred.await(pending)
    }), Effect.succeed({ enabled: false }))

    yield* Deferred.await(entered)
    const toggle = yield* display.presentation.toggle.pipe(Effect.forkChild)
    yield* Deferred.succeed(pending, { enabled: true })
    yield* Fiber.join(toggle)
    expect(display.frames.map((state) => state.enabled)).toEqual([undefined, true, false])
  }))

  it.effect("serializes repeated toggle commands", () => Effect.gen(function*() {
    let enabled = true
    let toggles = 0

    const display = yield* makeDisplay(Effect.sync(() => ({ enabled })), Effect.gen(function*() {
      const previous = enabled
      yield* Effect.yieldNow
      enabled = !previous
      toggles++

      return { enabled }
    }))

    yield* Queue.take(display.rendered)
    yield* Effect.all([display.presentation.toggle, display.presentation.toggle], { concurrency: "unbounded" })
    expect(toggles).toBe(2)
    expect(display.frames.at(-1)?.enabled).toBe(true)
  }))

  it.effect("reconciles external changes on the shared polling clock", () => Effect.gen(function*() {
    let enabled = true
    const display = yield* makeDisplay(Effect.sync(() => ({ enabled })), Effect.succeed({ enabled: false }))
    yield* Queue.take(display.rendered)
    enabled = false

    yield* TestClock.adjust("2 seconds")
    expect((yield* Queue.take(display.rendered)).enabled).toBe(false)
  }))

  it.effect("disposal interrupts pending reads and blocks queued toggles and late UI work", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    let toggles = 0

    const display = yield* makeDisplay(Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)

      return yield* Effect.never
    }), Effect.sync(() => { toggles++;

 return { enabled: false } }))

    yield* Deferred.await(entered)
    const toggle = yield* display.presentation.toggle.pipe(Effect.forkChild)
    yield* display.dispose
    yield* Fiber.join(toggle)
    yield* display.presentation.refresh
    yield* display.presentation.toggle
    expect(toggles).toBe(0)
    expect(display.frames).toEqual([{ enabled: undefined, dimmed: false }])
    expect(display.reports).toEqual([])
    yield* TestClock.adjust("5 seconds")
    expect(display.frames).toEqual([{ enabled: undefined, dimmed: false }])
  }))

  it.effect("disposal does not cancel an already-started persisted toggle", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    let enabled = true

    const display = yield* makeDisplay(Effect.succeed({ enabled }), Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)
      enabled = false

      return { enabled }
    }))

    yield* Queue.take(display.rendered)
    const toggle = yield* display.presentation.toggle.pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* display.dispose
    const frameCount = display.frames.length
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(toggle)
    expect(enabled).toBe(false)
    expect(display.frames.length).toBe(frameCount)
    yield* TestClock.adjust("5 seconds")
    expect(display.frames.length).toBe(frameCount)
  }))

  it.effect("deduplicates setup diagnostics and reports them again after recovery", () => Effect.gen(function*() {
    let status: ReviewStatus = { enabled: true, problem: "Configure a provider" }
    const display = yield* makeDisplay(Effect.sync(() => status), Effect.sync(() => status))
    yield* Queue.take(display.rendered)
    yield* display.presentation.refresh
    expect(display.reports).toEqual(["Configure a provider"])
    status = { enabled: true }
    yield* display.presentation.refresh
    status = { problem: "Configure a provider" }
    yield* display.presentation.refresh
    expect(display.reports).toEqual(["Configure a provider", "Configure a provider"])
    expect(display.frames.at(-1)?.enabled).toBeUndefined()
  }))

  it.effect("keeps toggles usable after an unavailable configuration read", () => Effect.gen(function*() {
    const display = yield* makeDisplay(Effect.fail(new ReviewPresentationError({ message: "Fix configuration" })), Effect.succeed({ enabled: false }))
    yield* display.presentation.refresh
    yield* display.presentation.toggle
    expect(display.frames.at(-1)?.enabled).toBe(false)
    expect(display.reports).toEqual(["Fix configuration"])
  }))
})

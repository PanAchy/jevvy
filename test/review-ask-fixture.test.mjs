import { expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { withReviewAskFixture } from "./review-ask-fixture.ts"

it.effect("removes the nomination fixture after a typed write failure", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  let fixture

  const exit = yield* withReviewAskFixture(({ directory, path, fs }) => Effect.gen(function*() {
    fixture = directory
    yield* fs.writeFileString(path.join(directory, "missing", "jevvy.jsonc"), "{}")
  })).pipe(Effect.exit)

  expect(exit._tag).toBe("Failure")

  if (Exit.isFailure(exit)) {
    expect(Cause.hasFails(exit.cause)).toBe(true)
    expect(Cause.hasDies(exit.cause)).toBe(false)
  }

  expect(fixture).toBeTypeOf("string")
  expect(yield* fs.exists(fixture)).toBe(false)
}).pipe(Effect.provide(NodeServices.layer)))

it.effect("removes the nomination fixture after interrupted use without producing an approval", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const entered = yield* Deferred.make()

  const running = yield* withReviewAskFixture(({ directory, path, fs }) => Effect.gen(function*() {
    yield* fs.writeFileString(path.join(directory, "jevvy.jsonc"), "{}")
    yield* Deferred.succeed(entered, directory)

    return yield* Effect.never
  })).pipe(Effect.forkChild)

  const directory = yield* Deferred.await(entered)
  yield* Fiber.interrupt(running)
  const exit = yield* Fiber.await(running)
  expect(exit._tag).toBe("Failure")

  if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(yield* fs.exists(directory)).toBe(false)
}).pipe(Effect.provide(NodeServices.layer)))

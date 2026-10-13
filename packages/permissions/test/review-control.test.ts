import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { parse } from "jsonc-parser"
import { createReviewControl, withReviewEnabled } from "../src/review-control.ts"
import { createConfigFile } from "../src/config-file.ts"

const withConfig = <A, E, R>(use: (path: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevvy-controls-"))
    const path = join(directory, "jevvy.jsonc")
    await writeFile(path, '{\n  // Keep credentials and comments\n  "provider": "typesafe",\n  "providers": {"typesafe": {"apiKey": "test-key"}},\n  "permissions": {"questions": {"original": true}}\n}\n')

    return { directory, path }
  }),
  ({ path }) => use(path),
  ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

describe("harness review controls", () => {
  it.effect("defaults existing configurations to enabled independently", () => withConfig((path) => Effect.gen(function*() {
    const control = yield* createReviewControl(path)
    expect(yield* control.read("opencode")).toEqual({ enabled: true })
    expect(yield* control.read("claude")).toEqual({ enabled: true })
  })))

  it.effect("persists independent toggles without replacing policy or credentials", () => withConfig((path) => Effect.gen(function*() {
    const control = yield* createReviewControl(path)
    const paused = yield* control.change("claude")
    expect(paused.enabled).toBe(false)
    expect(yield* (yield* createReviewControl(path)).read("claude")).toEqual(paused)
    expect((yield* control.read("opencode")).enabled).toBe(true)
    yield* control.change("opencode", false)
    const resumed = yield* control.change("claude")
    expect(resumed.enabled).toBe(true)
    expect(resumed).toEqual({ enabled: true })
    expect((yield* control.read("opencode")).enabled).toBe(false)
    const raw = yield* Effect.promise(() => readFile(path, "utf8"))
    expect(raw).toContain("// Keep credentials and comments")
    expect(raw).not.toContain("revision")
    expect(parse(raw)).toMatchObject({
      provider: "typesafe",
      providers: { typesafe: { apiKey: "test-key" } },
      permissions: { questions: { original: true } },
    })
    expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600)
  })))

  it.effect("bypasses all review work while paused and restores it after resume", () => withConfig((path) => Effect.gen(function*() {
    const control = yield* createReviewControl(path)
    const call = vi.fn(() => "allow")
    yield* control.change("claude", false)
    expect(yield* withReviewEnabled(control, "claude", Effect.sync(call))).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
    yield* control.change("claude", true)
    expect(yield* withReviewEnabled(control, "claude", Effect.sync(call))).toBe("allow")
    expect(call).toHaveBeenCalledOnce()
  })))

  it.effect.each(["opencode", "claude"] as const)("lets started %s reviews finish while OFF, but skips new reviews", (harness) => withConfig((path) => Effect.gen(function*() {
    const control = yield* createReviewControl(path)
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<string>()

    const fiber = yield* withReviewEnabled(control, harness, Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)

      return yield* Deferred.await(finish)
    })).pipe(Effect.forkChild)

    yield* Deferred.await(entered)
    yield* (yield* createReviewControl(path)).change(harness, false)
    const newReview = vi.fn(() => "allow")
    expect(yield* withReviewEnabled(control, harness, Effect.sync(newReview))).toBeUndefined()
    expect(newReview).not.toHaveBeenCalled()
    yield* Deferred.succeed(finish, "allow")
    expect(yield* Fiber.join(fiber)).toBe("allow")
  })))

  it.effect("lets started reviews finish after pause and resume", () => withConfig((path) => Effect.gen(function*() {
    const control = yield* createReviewControl(path)

    const review = Effect.gen(function*() {
      const other = yield* createReviewControl(path)
      yield* other.change("claude", false)
      yield* other.change("claude", true)

      return "allow"
    })

    expect(yield* withReviewEnabled(control, "claude", review)).toBe("allow")
  })))

  it.effect("does not invalidate the other harness's in-flight reviews", () => withConfig((path) => Effect.gen(function*() {
    const control = yield* createReviewControl(path)
    expect(yield* withReviewEnabled(control, "claude", control.change("opencode", false).pipe(Effect.as("allow")))).toBe("allow")
  })))

  it.effect("abstains without reviewing when state cannot be read", () => withConfig((path) => Effect.gen(function*() {
    yield* Effect.promise(() => writeFile(path, '{"permissions":{"claude":{"enabled":"invalid"}}}'))
    const call = vi.fn(() => "allow")
    expect(yield* withReviewEnabled(yield* createReviewControl(path), "claude", Effect.sync(call))).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })))

  it.effect.each(["opencode", "claude"] as const)("rejects malformed %s control fields without defaulting to ON", (harness) => withConfig((path) => Effect.gen(function*() {
    yield* Effect.promise(() => writeFile(path, JSON.stringify({
      provider: "custom",
      unrelated: { enabled: true },
      permissions: { questions: { original: true }, [harness]: { enable: false } },
    })))
    const control = yield* createReviewControl(path)
    const call = vi.fn(() => "allow")
    expect(yield* control.read(harness).pipe(Effect.flip)).toMatchObject({ operation: "parse" })
    expect(yield* withReviewEnabled(control, harness, Effect.sync(call))).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })))

  it.effect("does not commit or delete a replacement lease when takeover occurs during temporary writing", () => withConfig((path) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()

    const file = yield* createConfigFile(path, (temporary, content) => Effect.gen(function*() {
      yield* Effect.promise(() => writeFile(temporary, content, { mode: 0o600, flag: "w" }))
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)
    }))

    const oldControl = yield* createReviewControl(path, file)
    const old = yield* oldControl.change("opencode", false).pipe(Effect.exit, Effect.forkChild)
    yield* Deferred.await(entered)
    const lock = `${path}.review-lock`
    const displaced = `${path}.displaced-lock`
    yield* Effect.promise(async () => {
      await rename(lock, displaced)
      await mkdir(lock)
      await writeFile(path, '{"providers":{"typesafe":{"apiKey":"replacement-key"}},"permissions":{"claude":{"enabled":false}}}', { mode: 0o600 })
    })
    yield* Deferred.succeed(finish, undefined)
    expect((yield* Fiber.join(old))._tag).toBe("Failure")
    expect((yield* (yield* createReviewControl(path)).read("claude")).enabled).toBe(false)
    expect(yield* Effect.promise(() => readFile(path, "utf8"))).toContain("replacement-key")
    expect((yield* Effect.promise(() => stat(lock))).isDirectory()).toBe(true)
    expect((yield* Effect.promise(() => readdir(join(path, "..")))).some((name) => name.endsWith(".tmp"))).toBe(false)
  })))

  it.effect("refuses an expired lease before rename even without a compromise callback", () => withConfig((path) => Effect.gen(function*() {
    yield* TestClock.setTime(100_000)

    const file = yield* createConfigFile(path, (temporary, content) => Effect.gen(function*() {
      yield* Effect.promise(() => writeFile(temporary, content, { mode: 0o600, flag: "w" }))
      const expired = (yield* Clock.currentTimeMillis) / 1000 - 30
      yield* Effect.promise(() => utimes(`${path}.review-lock`, expired, expired))
    }))

    const control = yield* createReviewControl(path, file)
    expect(yield* control.change("opencode", false).pipe(Effect.flip)).toMatchObject({ operation: "write" })
    expect((yield* (yield* createReviewControl(path)).read("opencode")).enabled).toBe(true)
  })))

  it.effect("refuses a busy mutation without changing the configuration", () => withConfig((path) => Effect.gen(function*() {
    yield* Effect.promise(() => mkdir(`${path}.review-lock`))
    const control = yield* createReviewControl(path)
    const error = yield* control.change("claude").pipe(Effect.flip)
    expect(error.operation).toBe("busy")
    expect((yield* control.read("claude")).enabled).toBe(true)
  })))

  it.effect("serializes independent harness writes without losing either toggle", () => withConfig((path) => Effect.gen(function*() {
    const first = yield* createReviewControl(path)
    const second = yield* createReviewControl(path)
    yield* Effect.all([
      first.change("opencode", false),
      second.change("claude", false),
    ], { concurrency: "unbounded" })
    expect(yield* first.read("opencode")).toEqual({ enabled: false })
    expect(yield* second.read("claude")).toEqual({ enabled: false })
  })))

  it.effect("recovers an expired writer lease without manual lock removal", () => withConfig((path) => Effect.gen(function*() {
    const lock = `${path}.review-lock`
    yield* Effect.promise(() => mkdir(lock))
    const expired = new Date(Date.now() - 30_000)
    yield* Effect.promise(() => utimes(lock, expired, expired))
    expect(yield* (yield* createReviewControl(path)).change("claude", false)).toEqual({ enabled: false })
  })))

  it.effect("keeps the lock and temporary cleanup until an interrupted commit finishes", () => withConfig((path) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()

    const file = yield* createConfigFile(path, (target, content) => Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)
      yield* Effect.promise(() => writeFile(target, content, { mode: 0o600, flag: "w" }))
    }))

    const control = yield* createReviewControl(path, file)
    const writer = yield* control.change("opencode", false).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const interrupt = yield* Fiber.interrupt(writer).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    const second = yield* createReviewControl(path)
    const other = yield* second.change("claude", false).pipe(Effect.forkChild)
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(interrupt)
    yield* Fiber.join(other)
    expect(yield* second.read("opencode")).toEqual({ enabled: false })
    expect(yield* second.read("claude")).toEqual({ enabled: false })
    const names = yield* Effect.promise(() => readdir(join(path, "..")))
    expect(names).toEqual(["jevvy.jsonc"])
  })))

  it.effect("initialization and toggling share a read-modify-write transaction", () => withConfig((path) => Effect.gen(function*() {
    const file = yield* createConfigFile(path)
    const control = yield* createReviewControl(path)
    yield* Effect.all([
      file.update((raw) => Effect.succeed({
        content: `${raw?.trimEnd()}\n`,
        value: undefined,
      })),
      control.change("claude", false),
    ], { concurrency: "unbounded" })
    expect(yield* control.read("claude")).toEqual({ enabled: false })
  })))
})

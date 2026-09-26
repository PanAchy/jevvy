import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { createCommandCapture } from "../src/opencode/command-capture.ts"

const shellCall = (id: string, command: string, sessionID = "ses_one") => ({
  tool: "shell",
  sessionID,
  agent: "build",
  messageID: "msg_one",
  id,
  input: { command },
})

const request = (id: string, sessionID = "ses_one") => ({
  sessionID,
  source: { type: "tool" as const, messageID: "msg_one", id },
})

const invocation = (command: string) => ({ command, cwd: "/workspace", timeout: 1000, shell: "/bin/bash", env: {} })

describe("OpenCode shell command capture", () => {
  it.effect("joins the final command to its permission request across simultaneous tool calls", () => Effect.gen(function*() {
    const capture = createCommandCapture()
    const first = shellCall("call_one", "echo hello && pnpm build")
    const second = shellCall("call_two", "echo goodbye && pnpm test")

    yield* capture.before(first)
    yield* capture.shellBefore(invocation(first.input.command))
    yield* capture.before(second)
    yield* capture.shellBefore(invocation(second.input.command))

    expect(capture.commandFor(request("call_one"))).toBe(first.input.command)
    expect(capture.commandFor(request("call_two"))).toBe(second.input.command)

    yield* capture.after(first)

    expect(capture.commandFor(request("call_one"))).toBeUndefined()
    expect(capture.commandFor(request("call_two"))).toBe(second.input.command)
  }))

  it.effect("reads the shell command after later tool and shell hooks rewrite it", () => Effect.gen(function*() {
    const capture = createCommandCapture()
    const call = shellCall("changed", "echo original")

    yield* capture.before(call)
    expect(capture.commandFor(request("changed"))).toBeUndefined()

    call.input = { command: "echo changed by a later tool hook" }
    const shell = invocation(call.input.command)
    yield* capture.shellBefore(shell)
    shell.command = "echo final command from a later shell hook"

    expect(capture.commandFor(request("changed"))).toBe(shell.command)

    yield* capture.after(call)
    expect(capture.commandFor(request("changed"))).toBeUndefined()
  }))

  it.effect("keeps interleaved tool fibers correlated with their own shell invocations", () => Effect.gen(function*() {
    const capture = createCommandCapture()
    const firstReady = yield* Deferred.make<void>()
    const secondReady = yield* Deferred.make<void>()
    const first = shellCall("one", "echo one")
    const second = shellCall("two", "echo two")

    const one = yield* Effect.forkChild(Effect.gen(function*() {
      yield* capture.before(first)
      yield* Deferred.succeed(firstReady, undefined)
      yield* Deferred.await(secondReady)
      yield* capture.shellBefore(invocation(first.input.command))
    }))

    const two = yield* Effect.forkChild(Effect.gen(function*() {
      yield* Deferred.await(firstReady)
      yield* capture.before(second)
      yield* Deferred.succeed(secondReady, undefined)
      yield* capture.shellBefore(invocation(second.input.command))
    }))

    yield* Fiber.join(one)
    yield* Fiber.join(two)

    expect(capture.commandFor(request("one"))).toBe(first.input.command)
    expect(capture.commandFor(request("two"))).toBe(second.input.command)
  }))

  it.effect("refuses to guess when nested calls share a tool-call ID", () => Effect.gen(function*() {
    const capture = createCommandCapture()
    const first = shellCall("shared", "echo hello && pnpm build")
    const second = shellCall("shared", "echo goodbye && pnpm test")

    yield* capture.before(first)
    yield* capture.shellBefore(invocation(first.input.command))
    yield* capture.before(second)
    yield* capture.shellBefore(invocation(second.input.command))

    expect(capture.commandFor(request("shared"))).toBeUndefined()

    yield* capture.after(first)
    expect(capture.commandFor(request("shared"))).toBeUndefined()

    yield* capture.after(second)
    expect(capture.commandFor(request("shared"))).toBeUndefined()
  }))

  it.effect("does not mix sessions or unmatched permission sources", () => Effect.gen(function*() {
    const capture = createCommandCapture()
    const first = shellCall("shared", "echo hello", "ses_one")
    const second = shellCall("shared", "echo goodbye", "ses_two")

    yield* capture.before(first)
    yield* capture.shellBefore(invocation(first.input.command))
    yield* capture.before(second)
    yield* capture.shellBefore(invocation(second.input.command))

    expect(capture.commandFor(request("shared", "ses_one"))).toBe("echo hello")
    expect(capture.commandFor(request("shared", "ses_two"))).toBe("echo goodbye")
    expect(capture.commandFor({ sessionID: "ses_one" })).toBeUndefined()
  }))

  it.effect("bounds unpaired captures and abstains for an evicted call", () => Effect.gen(function*() {
    const capture = createCommandCapture()

    for (let index = 0; index < 513; index++) {
      yield* capture.before(shellCall(`call_${index}`, `echo ${index}`))
      yield* capture.shellBefore(invocation(`echo ${index}`))
    }

    expect(capture.commandFor(request("call_0"))).toBeUndefined()
    expect(capture.commandFor(request("call_512"))).toBe("echo 512")
  }))

  it.effect("abstains when a tool has multiple shell invocations or no complete command", () => Effect.gen(function*() {
    const capture = createCommandCapture()
    const call = shellCall("call", "echo hello")

    yield* capture.before(call)
    expect(capture.commandFor(request("call"))).toBeUndefined()

    yield* capture.shellBefore(invocation("  "))
    expect(capture.commandFor(request("call"))).toBeUndefined()

    yield* capture.shellBefore(invocation("echo hello"))
    expect(capture.commandFor(request("call"))).toBeUndefined()
  }))
})

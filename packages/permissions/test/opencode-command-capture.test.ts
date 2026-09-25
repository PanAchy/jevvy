import { describe, expect, it } from "vitest"
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

describe("OpenCode shell command capture", () => {
  it("joins the full command to its permission request across simultaneous tool calls", () => {
    const capture = createCommandCapture()
    const first = shellCall("call_one", "echo hello && pnpm build")
    const second = shellCall("call_two", "echo goodbye && pnpm test")

    capture.before(first)
    capture.before(second)

    expect(capture.commandFor(request("call_one"))).toBe(first.input.command)
    expect(capture.commandFor(request("call_two"))).toBe(second.input.command)

    capture.after(first)

    expect(capture.commandFor(request("call_one"))).toBeUndefined()
    expect(capture.commandFor(request("call_two"))).toBe(second.input.command)
  })

  it("refuses to guess when nested calls share a tool-call ID", () => {
    const capture = createCommandCapture()
    const first = shellCall("shared", "echo hello && pnpm build")
    const second = shellCall("shared", "echo goodbye && pnpm test")

    capture.before(first)
    capture.before(second)

    expect(capture.commandFor(request("shared"))).toBeUndefined()

    capture.after(first)
    expect(capture.commandFor(request("shared"))).toBeUndefined()

    capture.after(second)
    expect(capture.commandFor(request("shared"))).toBeUndefined()
  })

  it("does not mix sessions or unmatched permission sources", () => {
    const capture = createCommandCapture()
    const first = shellCall("shared", "echo hello", "ses_one")
    const second = shellCall("shared", "echo goodbye", "ses_two")

    capture.before(first)
    capture.before(second)

    expect(capture.commandFor(request("shared", "ses_one"))).toBe("echo hello")
    expect(capture.commandFor(request("shared", "ses_two"))).toBe("echo goodbye")
    expect(capture.commandFor({ sessionID: "ses_one" })).toBeUndefined()
  })

  it("bounds unpaired captures and abstains for an evicted call", () => {
    const capture = createCommandCapture()

    for (let index = 0; index < 513; index++) capture.before(shellCall(`call_${index}`, `echo ${index}`))

    expect(capture.commandFor(request("call_0"))).toBeUndefined()
    expect(capture.commandFor(request("call_512"))).toBe("echo 512")
  })
})

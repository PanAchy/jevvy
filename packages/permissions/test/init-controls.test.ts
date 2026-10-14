import { stripVTControlCharacters } from "node:util"
import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Terminal from "effect/Terminal"
import stringWidth from "string-width"
import * as Controls from "../src/init/controls.ts"
import { clearFrame, graphemes, wrapText } from "../src/init/layout.ts"
import { enter, key, scriptedTerminal, textKeys } from "./terminal-fixture.ts"

describe("setup controls", () => {
  it.effect("prevents an empty harness selection and preserves selected order", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter, key("space"), key("down"), key("space"), enter]])

    const selected = yield* Controls.multiSelect({ message: "Agents", min: 1, choices: [
      { value: "opencode", title: "OpenCode" }, { value: "claude", title: "Claude Code" },
    ] }).pipe(Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer))

    expect(selected).toEqual(["opencode", "claude"])
    expect(ui.output()).toContain("Select at least 1 option")
  }))

  it.effect("supports undefined choice values without mistaking them for absent choices", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter]])

    const selected = yield* Controls.select({ message: "Optional", choices: [{ value: undefined, title: "None" }] }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(selected).toBeUndefined()
    expect(ui.output()).toMatch(/Optional\n│  None/)
  }))

  it.effect("keeps the focused option visible in a short, narrow terminal", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[key("up"), enter]], 24, 12)

    const selected = yield* Controls.select({ message: "Choose a provider", choices: Array.from({ length: 9 }, (_, value) => ({ value, title: `Provider ${value}` })) }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(selected).toBe(8)
    expect(ui.output()).toContain("● Provider 8")
    expect(ui.output()).toContain("↑ more choices")

    for (const frame of ui.frames()) {
      for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThan(24)
      expect(frame.split("\n").length - 1).toBeLessThanOrEqual(12)
    }
  }))

  it.effect("edits Unicode graphemes without splitting emoji or combining characters", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[key("paste", "🙂e\u0301中"), key("left"), key("backspace"), key("home"), key("delete"), key("end"), key("x", "X"), enter]])

    const value = yield* Controls.text({ message: "Model" }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(value).toBe("中X")
    expect(ui.output()).not.toContain("\ufffd")
  }))

  it.effect("bounds wrapped descriptions, validation errors, and shortcuts inside a short viewport", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[key("down"), enter, key("space"), enter]], 18, 8)

    const selected = yield* Controls.multiSelect({ message: "Agents", min: 1, choices: [
      { value: "first", title: "First" },
      { value: "second", title: "Second", description: "A very long selected description that must not push errors or shortcuts off screen" },
      { value: "third", title: "Third" },
    ] }).pipe(Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer))

    expect(selected).toEqual(["second"])
    const errorFrame = ui.frames().find((frame) => frame.includes("Select at"))

    expect(errorFrame).toContain("◻ Second")
    expect(errorFrame).toContain("↑/↓")

    for (const frame of ui.frames()) {
      expect(frame.split("\n").length - 1).toBeLessThanOrEqual(8)

      for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThan(18)
    }
  }))

  it.effect("keeps the editing cursor visible when long text and validation exceed the viewport", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[key("paste", "模型".repeat(40)), enter, key("home"), key("u", undefined, true), key("x", "X"), enter]], 12, 6)

    const value = yield* Controls.text({ message: "Value", validate: (value) => value === "X" ? Effect.succeed(value) : Effect.fail("A long validation message requiring several wrapped lines") }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(value).toBe("X")

    for (const frame of ui.frames().filter((frame) => frame.includes("◆"))) {
      expect(frame).toContain("▋")
      expect(frame.split("\n").length - 1).toBeLessThanOrEqual(6)

      for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThan(12)
    }
  }))

  it.effect("wraps confirmation and degrades framing in extremely narrow terminals", () => Effect.gen(function*() {
    for (const columns of [2, 5, 10]) {
      const ui = scriptedTerminal([[enter]], columns, 4)
      expect(yield* Controls.confirm({ message: "Install?" }).pipe(
        Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
      )).toBe(false)

      if (columns >= 5) expect(ui.output()).toContain("● No")

      for (const frame of ui.frames()) {
        expect(frame.split("\n").length - 1).toBeLessThanOrEqual(4)

        for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns)
      }
    }
  }))

  it.effect("does not confuse typed cursor glyphs with the editing position", () => Effect.gen(function*() {
    const value = `▋${"a".repeat(60)}Z`
    const ui = scriptedTerminal([[key("paste", value), enter]], 14, 5)

    expect(yield* Controls.text({ message: "Value" }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )).toBe(value)
    expect(ui.frames().find((frame) => frame.includes("Z▋"))).toBeDefined()
  }))

  it.effect("supports validation, word deletion, and line-editing shortcuts", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter, ...textKeys("remove last"), key("w", undefined, true), key("a", undefined, true), key("k", undefined, true), ...textKeys("kept"), enter]])

    const value = yield* Controls.text({ message: "Value", validate: (value) => value === "" ? Effect.fail("Required") : Effect.succeed(value) }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(value).toBe("kept")
    expect(ui.output()).toContain("Required")
  }))

  it.effect("masks all Unicode password frames while retaining exact input and returning Redacted", () => Effect.gen(function*() {
    const secret = "κλειδί 密钥🔐 "
    const ui = scriptedTerminal([[key("paste", secret), enter]], 24)

    const result = yield* Controls.password({ message: "API key" }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(Redacted.value(result)).toBe(secret)
    expect(ui.output()).not.toContain("κλειδί")
    expect(ui.output()).not.toContain("密钥")
    expect(ui.output()).not.toContain("🔐")
    expect(ui.output()).toContain("*".repeat(graphemes(secret).length))
  }))

  it.effect("keeps confirmation defaults and allows a no response before submission", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[key("right"), enter]])
    expect(yield* Controls.confirm({ message: "Install?", initial: true }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )).toBe(false)
    expect(ui.output()).toMatch(/Install\?\n│  No/)
  }))

  it.effect("never renders password validator errors that echo or transform the secret", () => Effect.gen(function*() {
    const secret = "κλειδί🔐"
    const ui = scriptedTerminal([[key("paste", secret), enter, key("u", undefined, true), key("paste", "valid"), enter]])

    const result = yield* Controls.password({ message: "API key", validate: (value) => value === "valid" ? Effect.succeed(value) : Effect.fail(`Rejected ${value.toUpperCase()}: ${value.slice(0, 3)}`) }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(Redacted.value(result)).toBe("valid")
    expect(ui.output()).not.toContain(secret.toUpperCase())
    expect(ui.output()).not.toContain(secret.slice(0, 3))
    expect(ui.output()).toContain("Invalid value")
  }))

  it.effect("rejects control-bearing paste and edits graphemes assembled across input events", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[key("e", "e"), key("paste", "\u0301"), key("paste", "👩‍👩‍👧‍👦"), key("paste", "bad\u001b[2J"), key("paste", "bad\nline"), key("backspace"), enter]])

    const value = yield* Controls.text({ message: "Value" }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(value).toBe("e\u0301")
    expect(ui.output()).not.toContain("bad")
  }))

  it.effect("starts with fresh selection and input state when the same effects are reused", () => Effect.gen(function*() {
    const baseline = process.stdout.listenerCount("resize")
    const ui = scriptedTerminal([[key("down"), enter], [enter], [key("x", "X"), enter], [enter]])
    const select = Controls.select({ message: "Choice", choices: [{ title: "First", value: 1 }, { title: "Second", value: 2 }] })
    const text = Controls.text({ message: "Text", default: "Initial" })

    const values = yield* Effect.gen(function*() { return [yield* select, yield* select, yield* text, yield* text] }).pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(values).toEqual([2, 1, "InitialX", "Initial"])
    expect(process.stdout.listenerCount("resize")).toBe(baseline)
  }))

  it.effect("reports host quit keys and EOF as cancellation and restores listeners and cursor", () => Effect.gen(function*() {
    const baseline = process.stdout.listenerCount("resize")

    for (const quitKey of [undefined, "c", "d"]) {
      const input = yield* Queue.make<Terminal.UserInput, Cause.Done>()
      const frames: string[] = []

      if (quitKey !== undefined) yield* Queue.offer(input, key(quitKey, undefined, true))

      yield* Queue.end(input)

      const terminal = Terminal.make({
        columns: Effect.succeed(80), rows: Effect.succeed(20), readLine: Effect.die("unused"), readInput: Effect.succeed(input),
        display: (frame) => Effect.sync(() => { frames.push(frame) }),
      })

      const result = yield* Controls.password({ message: "Secret" }).pipe(
        Effect.provideService(Terminal.Terminal, terminal), Effect.provide(NodeServices.layer), Effect.flip,
      )

      expect(result).toBeInstanceOf(Terminal.QuitError)
      expect(process.stdout.listenerCount("resize")).toBe(baseline)
      expect(frames.join("")).toContain("\u001b[?25h")
      expect(frames.join("")).not.toContain("◇")
    }
  }))

  it.effect("redraws on resize and releases the listener and cursor on interruption", () => Effect.gen(function*() {
    const baseline = process.stdout.listenerCount("resize")
    const input = yield* Queue.make<Terminal.UserInput, Cause.Done>()
    const initial = yield* Deferred.make<void>()
    const resized = yield* Deferred.make<void>()
    const frames: string[] = []
    let columns = 80

    const terminal = Terminal.make({
      columns: Effect.sync(() => columns), rows: Effect.succeed(20), readLine: Effect.die("unused"), readInput: Effect.succeed(input),
      display: (frame) => Effect.gen(function*() {
        frames.push(frame)

        if (frame.includes("Choose a long provider")) yield* Deferred.succeed(initial, undefined)

        if (columns === 24 && stripVTControlCharacters(frame).includes("provider\n│")) yield* Deferred.succeed(resized, undefined)
      }),
    })

    const fiber = yield* Controls.select({ message: "Choose a long provider", choices: [{ value: "test", title: "测试🔐" }] }).pipe(
      Effect.provideService(Terminal.Terminal, terminal), Effect.provide(NodeServices.layer), Effect.forkChild,
    )

    yield* Deferred.await(initial)
    expect(process.stdout.listenerCount("resize")).toBe(baseline + 1)
    columns = 24
    process.stdout.emit("resize")
    yield* Deferred.await(resized)
    yield* Fiber.interrupt(fiber)
    expect(process.stdout.listenerCount("resize")).toBe(baseline)
    expect(frames.join("")).toContain("\u001b[?25h")
  }))

  it("wraps by display cells and preserves input spaces when word wrapping is off", () => {
    expect(wrapText("模型🔐", 4)).toEqual(["模型", "🔐"])
    expect(wrapText("  a  ", 4, { words: false })).toEqual(["  a ", " "])
    expect(graphemes("e\u0301🔐")).toEqual(["e\u0301", "🔐"])
    expect(clearFrame("│  模型🔐\n", 5)).toBe("\u001b[1A\u001b[2K\r".repeat(2))
    expect(wrapText("模型🔐", 1)).toEqual(["�", "�", "�"])
    expect(wrapText("safe\r\u0007\u001b[2J text", 20)).toEqual(["safe text"])
  })
})

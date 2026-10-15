import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Terminal from "effect/Terminal"
import { promptInitPlan } from "../src/init/prompt.ts"
import { enter, key, scriptedTerminal, textKeys as text } from "./terminal-fixture.ts"

const down = key("down")

describe("Effect-native setup terminal", () => {
  it.effect("runs real prompts, masks the key, and shows the summary before confirmation", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter], [enter], [...text("demo-secret"), enter], [enter]])

    const plan = yield* promptInitPlan("/isolated/jevvy.jsonc").pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(plan?.harnesses).toEqual(["opencode", "claude"])
    expect(plan?.provider.provider).toBe("zen")

    if (plan?.provider.apiKey === undefined) throw new Error("Expected a key")
    expect(Redacted.value(plan.provider.apiKey)).toBe("demo-secret")
    const output = ui.output()
    expect(output).not.toContain("demo-secret")
    expect(output).toContain("◆ Review setup")
    expect(output).toContain("Config: /isolated/jevvy.jsonc")
    expect(output).toContain("Bearer key: saved in private config")
    expect(output.indexOf("◆ Review setup")).toBeLessThan(output.indexOf("Save config and install integrations?"))
    expect(ui.completed()).toBe(4)
  }))

  it.effect("keeps menu hints below choices and completed answers below their questions", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter], [enter], [...text("demo-secret"), enter], [enter]])
    yield* promptInitPlan("/isolated/jevvy.jsonc").pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    const output = ui.output()
    expect(output).toMatch(/Which harnesses should use Jevvy Permissions\?\n│  OpenCode, Claude Code/)
    expect(output).toMatch(/◼ Claude Code[^\n]*\n│  ↑\/↓ to navigate • Space: select • Enter: confirm/)
    expect(output).toMatch(/Which decision provider should Jevvy use\?\n│  OpenCode Zen/)
    expect(output).not.toContain("Inverse Selection")
  }))

  it.effect("shows Laya's policy warning before confirming a credential-free plan", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter], [down, down, down, down, enter], [enter], [enter], [enter], [enter]])

    const plan = yield* promptInitPlan("/isolated/jevvy.jsonc").pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(plan?.provider).toEqual({ provider: "laya" })
    const output = ui.output()
    expect(output).toContain("Laya needs a checkpoint-specific policy; without one, auto-approval stays off.")
    expect(output.indexOf("Laya needs")).toBeLessThan(output.indexOf("Save config and install integrations?"))
    expect(ui.completed()).toBe(6)
  }))

  it.effect("returns a typed cancellation when terminal input ends", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[]])

    const error = yield* promptInitPlan("/isolated/jevvy.jsonc").pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer), Effect.flip,
    )

    expect(error._tag).toBe("QuitError")
    expect(ui.completed()).toBe(1)
    expect(ui.output()).not.toContain("Review setup")
  }))

  it.effect("selects OpenAI by typing its name and shows calibration guidance before saving", () => Effect.gen(function*() {
    const ui = scriptedTerminal([[enter], [...text("OPENAI"), enter], [...text("openai-secret"), enter], [enter]])

    const plan = yield* promptInitPlan("/isolated/jevvy.jsonc").pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(plan?.provider.provider).toBe("openai")

    if (plan?.provider.apiKey === undefined) throw new Error("Expected an OpenAI key")

    expect(Redacted.value(plan.provider.apiKey)).toBe("openai-secret")

    const output = ui.output()

    expect(output).toContain("Type to filter")
    expect(output).toContain("calibrated for Jev, not this model")
    expect(output.indexOf("calibrated for Jev")).toBeLessThan(output.indexOf("Save config and install integrations?"))
    expect(output).not.toContain("openai-secret")
  }))

  it.effect("selects Microsoft by model name and collects the full endpoint, deployment, and masked Azure key", () => Effect.gen(function*() {
    const ui = scriptedTerminal([
      [enter], [...text("decision-1"), enter],
      [...text("https://foundry.example.com/providers/microsoft/v1/systemone"), enter],
      [...text("my-deployment"), enter], [...text("azure-secret"), enter], [enter],
    ])

    const plan = yield* promptInitPlan("/isolated/jevvy.jsonc").pipe(
      Effect.provideService(Terminal.Terminal, ui.terminal), Effect.provide(NodeServices.layer),
    )

    expect(plan?.provider).toMatchObject({
      provider: "microsoft", endpoint: "https://foundry.example.com/providers/microsoft/v1/systemone", model: "my-deployment",
    })
    expect(ui.output()).toContain("Azure API key: saved in private config")
    expect(ui.output()).toContain("calibrated for Jev, not this model")
    expect(ui.output()).not.toContain("azure-secret")
  }))
})

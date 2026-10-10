import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { parse } from "jsonc-parser"
import {
  initializeJevvy,
  InitPlatform,
  renderJevvyConfig,
} from "../src/init/index.ts"
import {
  harnessPrompt,
  initConfirmationMessage,
  initPlanSummary,
  layaNextSteps,
  opencodeNextSteps,
} from "../src/init/prompt.ts"

describe("Jevvy initializer", () => {
  it("tells OpenCode users how to opt shell requests into review without changing their policy", () => {
    expect(opencodeNextSteps()).toContain('{ "action": "shell", "resource": "*", "effect": "ask" }')
    expect(opencodeNextSteps()).toContain("before specific shell rules")
    expect(opencodeNextSteps()).toContain("allow and deny stay final; specific asks stay human-only")
    expect(opencodeNextSteps()).toContain("not reviewed by Jevvy")
  })

  it("formats provider and harness names for confirmation", () => {
    expect(initPlanSummary({
      harnesses: ["opencode", "claude"],
      provider: { provider: "typesafe", apiKey: Redacted.make("secret") },
    }, "/home/user/.config/jevvy/jevvy.jsonc")).toBe([
      "TypeSafe AI for OpenCode + Claude Code",
      "Config: /home/user/.config/jevvy/jevvy.jsonc",
      "Bearer key: saved in private config",
    ].join("\n"))
  })

  it("puts the Laya plan and approval warning inside the confirmation question", () => {
    const message = stripVTControlCharacters(initConfirmationMessage({
      harnesses: ["opencode", "claude"],
      provider: { provider: "laya", model: "typed-decisions" },
    }, "/tmp/jevvy.jsonc"))

    expect(message).toBe([
      "Save config and install integrations?",
      "Laya (typed-decisions) for OpenCode + Claude Code",
      "Config: /tmp/jevvy.jsonc",
      "Server: http://127.0.0.1:8000/v1/systemone",
      "",
      "Laya needs a checkpoint-specific policy; without one, auto-approval stays off.",
    ].join("\n"))
  })

  it("keeps ordinary provider confirmation compact", () => {
    const message = stripVTControlCharacters(initConfirmationMessage({
      harnesses: ["opencode"],
      provider: { provider: "typesafe", apiKey: Redacted.make("secret") },
    }, "/tmp/jevvy.jsonc"))

    expect(message).toBe([
      "Save config and install integrations?",
      "TypeSafe AI for OpenCode",
      "Config: /tmp/jevvy.jsonc",
      "Bearer key: saved in private config",
    ].join("\n"))
    expect(message).not.toContain("secret")
  })

  it("does not print credentials or URL parameters in custom provider confirmation", () => {
    const message = stripVTControlCharacters(initConfirmationMessage({
      harnesses: ["claude"],
      provider: {
        provider: "custom",
        endpoint: "https://name:secret@example.com/v1/decisions?token=other-secret#fragment",
        model: "typesafe/jev",
      },
    }, "/tmp/jevvy.jsonc"))

    expect(message).toContain("Server: https://example.com (URL details saved in private config)")
    expect(message).not.toContain("name")
    expect(message).not.toContain("secret")
    expect(message).not.toContain("token")
    expect(message).not.toContain("fragment")
  })

  it("requires OpenCode reactivation and status verification after Laya calibration", () => {
    const steps = layaNextSteps({
      provider: "laya",
      harnesses: ["opencode", "claude"],
      configPath: "/tmp/jevvy.jsonc",
    })

    expect(steps).toContain("If this checkpoint has no calibrated policy")
    expect(steps).toContain("providers.laya.policy")
    expect(steps).toContain("opencode service restart")
    expect(steps).toContain("jevvy.permissions must be active")
    expect(steps).toContain("calibrate-permissions")
  })

  it("does not tell Claude-only users to restart OpenCode", () => {
    const steps = layaNextSteps({
      provider: "laya",
      harnesses: ["claude"],
      configPath: "/tmp/jevvy.jsonc",
    })

    expect(steps).not.toContain("OpenCode")
    expect(steps).not.toContain("jevvy.permissions must be active")
  })

  it("offers OpenCode and Claude Code as selected harness checkboxes", () => {
    expect(harnessPrompt).toEqual({
      message: "Which harnesses should use Jevvy?",
      options: [
        { value: "opencode", label: "OpenCode", hint: "permission plugin" },
        { value: "claude", label: "Claude Code", hint: "PermissionRequest hook" },
      ],
      initialValues: ["opencode", "claude"],
      required: true,
    })
  })

  it("describes stored OpenCode Zen credentials without exposing the secret", () => {
    expect(initPlanSummary({
      harnesses: ["opencode", "claude"],
      provider: { provider: "zen", apiKey: Redacted.make("secret") },
    }, "/home/user/.config/jevvy/jevvy.jsonc")).toContain(
      "Bearer key: saved in private config",
    )
  })

  it.effect("renders a new custom provider configuration", () => Effect.gen(function*() {
    const rendered = yield* renderJevvyConfig(undefined, {
      provider: "custom",
      endpoint: "https://api.aimlapi.com/v1/decisions",
      model: "typesafe/jev",
      apiKey: Redacted.make("secret"),
    })

    expect(parse(rendered)).toEqual({
      $schema: "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
      provider: "custom",
      providers: {
        custom: {
          endpoint: "https://api.aimlapi.com/v1/decisions",
          model: "typesafe/jev",
          apiKey: "secret",
        },
      },
    })
  }))

  it.effect("configures Laya without embedding an uncalibrated permission policy", () => Effect.gen(function*() {
    const rendered = yield* renderJevvyConfig(undefined, { provider: "laya" })

    expect(parse(rendered)).toEqual({
      $schema: "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
      provider: "laya",
    })

    const summary = initPlanSummary({
      harnesses: ["opencode"],
      provider: { provider: "laya" },
    }, "/home/user/.config/jevvy/jevvy.jsonc")

    expect(summary).toBe([
      "Laya (english) for OpenCode",
      "Config: /home/user/.config/jevvy/jevvy.jsonc",
      "Server: http://127.0.0.1:8000/v1/systemone",
    ].join("\n"))
  }))

  it.effect("saves overridden Laya server, checkpoint, and Bearer key", () => Effect.gen(function*() {
    const rendered = yield* renderJevvyConfig(undefined, {
      provider: "laya",
      endpoint: "http://127.0.0.1:18871/v1/systemone",
      model: "multilingual",
      apiKey: Redacted.make("local-secret"),
    })

    expect(parse(rendered).providers.laya).toEqual({
      endpoint: "http://127.0.0.1:18871/v1/systemone",
      model: "multilingual",
      apiKey: "local-secret",
    })

    const summary = initPlanSummary({
      harnesses: ["claude"],
      provider: {
        provider: "laya",
        endpoint: "http://127.0.0.1:18871/v1/systemone",
        model: "multilingual",
        apiKey: Redacted.make("local-secret"),
      },
    }, "/home/user/.config/jevvy/jevvy.jsonc")

    expect(summary).toContain("Server: http://127.0.0.1:18871/v1/systemone")
    expect(summary).toContain("Laya (multilingual) for Claude Code")
    expect(summary).toContain("Bearer key: saved in private config")
    expect(summary).not.toContain("local-secret")
  }))

  it.effect("preserves unrelated JSONC configuration while changing providers", () => Effect.gen(function*() {
    const existing = `{
      // Keep this policy.
      "provider": "typesafe",
      "providers": { "typesafe": { "apiKey": "old" } },
      "permissions": {
        "questions": {
          "safe": {
            "type": "noul",
            "instructions": "Risky?",
            "threshold": 0.1
          }
        }
      }
    }`

    const rendered = yield* renderJevvyConfig(existing, {
      provider: "openrouter",
      apiKey: Redacted.make("new"),
    })

    const document = parse(rendered)

    expect(rendered).toContain("// Keep this policy.")
    expect(document.provider).toBe("openrouter")
    expect(document.providers.openrouter).toEqual({ apiKey: "new" })
    expect(document.permissions.questions.safe.instructions).toBe("Risky?")
    expect(document.permissions.questions.safe.threshold).toBe(0.1)
  }))

  it.effect("does not carry another model's questions into Laya", () => Effect.gen(function*() {
    const existing = JSON.stringify({
      provider: "typesafe",
      providers: { typesafe: { apiKey: "existing-key" } },
      permissions: { questions: { harmful: { type: "noul", instructions: "Risk?", threshold: 0.35 } } },
    })

    const error = yield* renderJevvyConfig(existing, { provider: "laya" }).pipe(Effect.flip)

    expect(error).toMatchObject({
      operation: "validate-plan",
      message: expect.stringContaining("Move or remove top-level permission questions"),
    })
  }))

  it.effect("keeps Laya questions nested when switching to another provider", () => Effect.gen(function*() {
    const existing = JSON.stringify({
      provider: "laya",
      providers: { laya: { policy: {
        checkpoint: "english",
        questions: { harmful: { type: "noul", instructions: "Risk?", threshold: 0.35 } },
      } } },
    })

    const events: string[] = []

    const layer = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.sync(() => {
        events.push("read")

        return existing
      }),
      updateConfig: (_path, edit) => Effect.gen(function*() {
        events.push("read")
        yield* edit(existing)
        events.push("write")
      }),
      installHarness: () => Effect.sync(() => { events.push("install") }),
    }))

    yield* initializeJevvy({
      harnesses: ["opencode"],
      provider: { provider: "zen", apiKey: Redacted.make("new-key") },
    }, "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(layer))

    expect(events).toEqual(["read", "write", "install"])
    const rendered = yield* renderJevvyConfig(existing, { provider: "zen", apiKey: Redacted.make("new-key") })

    expect(parse(rendered).providers.laya.policy.questions.harmful.threshold).toBe(0.35)
    expect(parse(rendered).permissions).toBeUndefined()
  }))

  it.effect("preserves Laya policy when rerunning init with the same endpoint and checkpoint", () => Effect.gen(function*() {
    const policy = { checkpoint: "english", questions: { harmful: { type: "noul", instructions: "Risk?", threshold: 0.35 } } }

    const existing = `{
      "provider": "zen",
      "providers": { "laya": {
        // Keep the calibrated threshold explanation.
        "policy": ${JSON.stringify(policy)}
      } }
    }`

    const rendered = yield* renderJevvyConfig(existing, { provider: "laya" })

    expect(parse(rendered).providers.laya).toEqual({ policy })
    expect(rendered).toContain("// Keep the calibrated threshold explanation.")
  }))

  it.effect("does not discard a Laya policy when init changes its server or checkpoint", () => Effect.gen(function*() {
    const existing = JSON.stringify({ provider: "laya", providers: { laya: {
      policy: { checkpoint: "english", questions: { harmful: { type: "noul", instructions: "Risk?", threshold: 0.35 } } },
    } } })

    for (const provider of [
      { provider: "laya" as const, model: "multilingual" },
      { provider: "laya" as const, endpoint: "https://example.com/v1/systemone" },
    ]) {
      const error = yield* renderJevvyConfig(existing, provider).pipe(Effect.flip)

      expect(error).toMatchObject({ operation: "validate-plan", message: expect.stringContaining("recalibrate") })
    }
  }))

  it.effect("clears previous Laya overrides when init selects local defaults without a key", () => Effect.gen(function*() {
    const existing = JSON.stringify({
      provider: "laya",
      providers: {
        laya: { endpoint: "http://127.0.0.1:18871/v1/systemone", model: "multilingual", apiKey: "old-key" },
        typesafe: { apiKey: "other-key" },
      },
    })

    const rendered = yield* renderJevvyConfig(existing, { provider: "laya" })

    expect(parse(rendered).providers).toEqual({ laya: {}, typesafe: { apiKey: "other-key" } })
  }))

  it.effect("replaces previous Laya key when init selects a new server without one", () => Effect.gen(function*() {
    const existing = JSON.stringify({
      provider: "laya",
      providers: { laya: { endpoint: "http://127.0.0.1:18871/v1/systemone", apiKey: "old-key" } },
    })

    const rendered = yield* renderJevvyConfig(existing, {
      provider: "laya",
      endpoint: "http://127.0.0.1:18872/v1/systemone",
      model: "typed-decisions",
    })

    expect(parse(rendered).providers.laya).toEqual({
      endpoint: "http://127.0.0.1:18872/v1/systemone",
      model: "typed-decisions",
    })
  }))

  it.effect.each(["[]", "null", '"text"', "42"])(
    "rejects a non-object JSONC root: %s",
    (existing) => Effect.gen(function*() {
      const error = yield* renderJevvyConfig(existing, {
        provider: "zen",
        apiKey: Redacted.make("unused"),
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        operation: "parse-config",
        message: "Existing jevvy.jsonc must contain an object",
      })
    }),
  )

  it.effect("writes configuration before installing every selected harness", () => Effect.gen(function*() {
    const events: string[] = []

    const layer = Layer.succeed(InitPlatform, InitPlatform.of({
      readConfig: () => Effect.succeed(undefined),
      updateConfig: (_path, edit) => Effect.gen(function*() {
        const content = yield* edit(undefined)
        events.push(`write:${parse(content).provider}`)
      }),
      installHarness: (harness) => Effect.sync(() => {
        events.push(`install:${harness}`)
      }),
    }))

    const result = yield* initializeJevvy({
      harnesses: ["opencode", "claude"],
      provider: { provider: "typesafe", apiKey: Redacted.make("secret") },
    }, "/home/user/.config/jevvy/jevvy.jsonc").pipe(Effect.provide(layer))

    expect(events).toEqual(["write:typesafe", "install:opencode", "install:claude"])
    expect(result).toEqual({
      configPath: "/home/user/.config/jevvy/jevvy.jsonc",
      harnesses: ["opencode", "claude"],
      provider: "typesafe",
    })
  }))

  it.effect("installs Claude Code through its user marketplace", () => {
    const commands: string[][] = []

    const spawner = ChildProcessSpawner.make((command) => Effect.sync(() => {
      if (!("command" in command)) throw new Error("unexpected command pipeline")

      commands.push([command.command, ...command.args])

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }))

    return Effect.gen(function*() {
      const platform = yield* InitPlatform

      yield* platform.installHarness("claude")

      expect(commands).toEqual([
        ["claude", "plugin", "marketplace", "add", "--scope", "user", "PanAchy/jevvy"],
        ["claude", "plugin", "install", "--scope", "user", "jevvy-permissions@jevvy"],
      ])
    }).pipe(
      Effect.provide(InitPlatform.layer),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(NodeServices.layer),
    )
  })

  it.effect("writes credential-bearing configuration with mode 0600", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "jevvy-init-"))),
      (directory) => Effect.gen(function*() {
        const path = join(directory, "jevvy.jsonc")
        const platform = yield* InitPlatform

        yield* platform.updateConfig(path, () => Effect.succeed("{\"apiKey\":\"secret\"}\n"))
        expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600)
      }).pipe(
        Effect.provide(InitPlatform.layer),
        Effect.provide(NodeServices.layer),
      ),
      (directory) => Effect.promise(() => rm(directory, { recursive: true })),
    ))
})

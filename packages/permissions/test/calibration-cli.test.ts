import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { missingProviderMessage } from "../src/calibration-cli.ts"

describe("calibration command", () => {
  it("reports the Vercel credential sources", () => {
    expect(missingProviderMessage("vercel")).toBe(
      "Vercel AI Gateway calibration needs providers.vercel.apiKey or AI_GATEWAY_API_KEY",
    )
  })

  it.effect("uses Effect dotenv fallback without overwriting environment values or expanding variables", () => Effect.gen(function*() {
    const ambient = { TYPESAFE_API_KEY: "environment-key", OPENCODE_API_KEY: "" }
    const dotenv = ConfigProvider.fromDotEnvContents("TYPESAFE_API_KEY=dotenv-key\nOPENCODE_API_KEY=dotenv-zen\nQUOTED='with # hash'\nLITERAL=${TYPESAFE_API_KEY}\nEMPTY=", { preserveEmptyStrings: true })
    const provider = ConfigProvider.orElse(ConfigProvider.fromEnv({ env: ambient, preserveEmptyStrings: true }), dotenv)

    expect(yield* Config.String("TYPESAFE_API_KEY").parse(provider)).toBe("environment-key")
    expect(yield* Config.String("OPENCODE_API_KEY").parse(provider)).toBe("")
    expect(yield* Config.String("QUOTED").parse(provider)).toBe("with # hash")
    expect(yield* Config.String("LITERAL").parse(provider)).toBe("${TYPESAFE_API_KEY}")
    expect(yield* Config.String("EMPTY").parse(provider)).toBe("")
    expect(ambient).toEqual({ TYPESAFE_API_KEY: "environment-key", OPENCODE_API_KEY: "" })

    const emptyCredential = yield* Config.schema(Schema.Redacted(Schema.NonEmptyString), "OPENCODE_API_KEY").parse(provider).pipe(Effect.flip)

    expect(emptyCredential).toBeInstanceOf(Config.ConfigError)
  }))

  it.effect("loads dotenv privately and treats only a missing file as optional", () => Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "jevvy-dotenv-" })
    const path = `${directory}/.env`

    const optionalDotEnv = ConfigProvider.fromDotEnv({ path, preserveEmptyStrings: true }).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(ConfigProvider.fromDotEnvContents(""))),
    )

    const missing = yield* optionalDotEnv

    expect(yield* missing.load(["KEY"])).toBeUndefined()

    yield* fs.writeFileString(path, "KEY=dotenv-key")
    const loaded = yield* optionalDotEnv

    expect(yield* Config.String("KEY").parse(loaded)).toBe("dotenv-key")

    yield* fs.remove(path)
    yield* fs.makeDirectory(path)
    const unreadable = yield* optionalDotEnv.pipe(Effect.flip)

    expect(unreadable).toBeInstanceOf(PlatformError.PlatformError)
    expect(unreadable.reason._tag).not.toBe("NotFound")
  })).pipe(Effect.provide(NodeServices.layer)))
})

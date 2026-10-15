import { createServer } from "node:http"
import { stripVTControlCharacters } from "node:util"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import type * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { windowsHostFixture } from "./init-smoke-fixture.ts"

export class SetupSmokeError extends Schema.TaggedError<SetupSmokeError>()("SetupSmokeError", { message: Schema.String }) {}

const ensure = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new SetupSmokeError({ message }))

interface Transcript {
  readonly stdout: string
  readonly stderr: string
  readonly offset: number
}

interface Step {
  readonly prompt: string
  readonly input: string | null
}

const drive = Effect.fn("SetupSmoke.drive")(function*(bin: string, cwd: string, env: Readonly<Record<string, string>>, steps: readonly Step[], ending: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const input = yield* Queue.make<Uint8Array, Cause.Done>()
  const transcript = yield* SubscriptionRef.make<Transcript>({ stdout: "", stderr: "", offset: 0 })

  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [bin, "init"], {
    cwd, env, extendEnv: false, stdin: Stream.fromQueue(input), forceKillAfter: "1 second",
  }))

  const stdout = yield* Stream.decodeText(handle.stdout).pipe(Stream.runForEach((chunk) => SubscriptionRef.update(transcript, (value) => ({ ...value, stdout: value.stdout + chunk }))), Effect.forkChild)
  const stderr = yield* Stream.decodeText(handle.stderr).pipe(Stream.runForEach((chunk) => SubscriptionRef.update(transcript, (value) => ({ ...value, stderr: value.stderr + chunk }))), Effect.forkChild)
  const exit = yield* handle.exitCode.pipe(Effect.forkChild)
  const find = (value: Transcript, text: string) => stripVTControlCharacters(value.stdout).indexOf(text, value.offset)

  const wait = Effect.fn("SetupSmoke.waitFor")(function*(text: string) {
    const available = SubscriptionRef.changes(transcript).pipe(
      Stream.filter((value) => find(value, text) >= 0), Stream.runHead,
      Effect.flatMap(Option.match({ onNone: () => new SetupSmokeError({ message: `No output while waiting for ${text}` }), onSome: Effect.succeed })),
    )

    const closed = Effect.gen(function*() {
      yield* Fiber.join(exit)
      yield* Fiber.join(stdout)
      yield* Fiber.join(stderr)
      const value = yield* SubscriptionRef.get(transcript)
      yield* ensure(find(value, text) >= 0, `Setup exited before ${text}: ${stripVTControlCharacters(value.stdout)} ${value.stderr}`)

      return value
    })

    const value = yield* Effect.raceFirst(available, closed).pipe(Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => SubscriptionRef.get(transcript).pipe(Effect.flatMap((value) => new SetupSmokeError({
        message: `Setup did not reach ${text}: ${stripVTControlCharacters(value.stdout)} ${value.stderr}`,
      }))),
    }))

    yield* SubscriptionRef.update(transcript, (current) => ({ ...current, offset: find(value, text) + text.length }))
  })

  const encoder = new TextEncoder()

  for (const step of steps) {
    yield* wait(step.prompt)

    if (step.input === null) yield* Queue.end(input)
    else yield* Queue.offer(input, encoder.encode(step.input))
  }

  yield* wait(ending)
  yield* Queue.end(input)

  const code = yield* Fiber.join(exit).pipe(Effect.timeoutOrElse({
    duration: "10 seconds", orElse: () => new SetupSmokeError({ message: "Setup did not release its input and exit" }),
  }))

  yield* Fiber.join(stdout)
  yield* Fiber.join(stderr)
  const result = yield* SubscriptionRef.get(transcript)

  return { code, raw: result.stdout, output: stripVTControlCharacters(result.stdout), stderr: result.stderr }
}, Effect.scoped)

const Call = Schema.Struct({ host: Schema.String, args: Schema.Array(Schema.String) })

type Call = typeof Call.Type

const Config = Schema.Struct({ provider: Schema.Literal("custom"), providers: Schema.Struct({ custom: Schema.Struct({
  endpoint: Schema.String, model: Schema.String, apiKey: Schema.optionalKey(Schema.String),
}) }) })

const decodeCall = Schema.decodeEffect(Schema.fromJsonString(Call))

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(Config))

type Agents = "both" | "claude" | "opencode"

interface Scenario {
  readonly name: string
  readonly agents: Agents
  readonly cancelFirst?: boolean
  readonly cancelPlan?: boolean
  readonly existing?: string
  readonly version?: string
  readonly override?: boolean
  readonly missing?: boolean
  readonly installExit?: number
  readonly expectedCode?: number
  readonly key?: string
  readonly eof?: boolean
  readonly searchProvider?: boolean
}

const cases: readonly Scenario[] = [
  { name: "both agents", agents: "both" },
  { name: "typed provider search", agents: "claude", searchProvider: true },
  { name: "Claude only without OpenCode", agents: "claude", missing: true },
  { name: "cancel first prompt", agents: "opencode", cancelFirst: true },
  { name: "cancel confirmation", agents: "opencode", cancelPlan: true, existing: '{ "provider": "typesafe" }\n' },
  { name: "old version decline", agents: "opencode", version: "2.0.26", override: false },
  { name: "old version override", agents: "opencode", version: "2.0.26", override: true },
  { name: "unknown version decline", agents: "opencode", version: "nightly-custom", override: false },
  { name: "missing CLI", agents: "opencode", missing: true, expectedCode: 1 },
  { name: "failed installer", agents: "opencode", installExit: 3, expectedCode: 1 },
  { name: "masked credential", agents: "opencode", key: "fixture-private-key" },
  { name: "EOF during credential entry", agents: "opencode", eof: true },
]

const expectedCommands: Readonly<Record<Agents, readonly Call[]>> = {
  both: [
    { host: "opencode", args: ["plugin", "add", "@jevvy/permissions"] },
    { host: "claude", args: ["plugin", "marketplace", "add", "--scope", "user", "PanAchy/jevvy"] },
    { host: "claude", args: ["plugin", "install", "--scope", "user", "jevvy-permissions@jevvy"] },
  ],
  claude: [
    { host: "claude", args: ["plugin", "marketplace", "add", "--scope", "user", "PanAchy/jevvy"] },
    { host: "claude", args: ["plugin", "install", "--scope", "user", "jevvy-permissions@jevvy"] },
  ],
  opencode: [{ host: "opencode", args: ["plugin", "add", "@jevvy/permissions"] }],
}

const fakeHostSource = `
import { appendFileSync, readFileSync } from "node:fs"
const state = JSON.parse(readFileSync(process.env.JEVVY_SMOKE_STATE, "utf8"))
const [host, ...args] = process.argv.slice(2)
appendFileSync(state.calls, JSON.stringify({ host, args }) + "\\n")
if (args[0] === "--version") {
  console.log(host === "opencode" ? "opencode v" + state.version : "2.1.296")
  process.exit(0)
}
console.log("Fixture installer: " + host)
process.exit(state.installExit)
`

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const planSteps = (scenario: Scenario, endpoint: string): readonly Step[] => {
  const down = "\u001b[B"

  const agents = Match.value(scenario.agents).pipe(
    Match.when("both", () => "\r"), Match.when("claude", () => " \r"), Match.when("opencode", () => `${down} \r`), Match.exhaustive,
  )

  const steps: Step[] = [{ prompt: "Which harnesses should use Jevvy Permissions?", input: scenario.cancelFirst ? "\u0003" : agents }]

  if (scenario.cancelFirst) return steps
  const providerInput = scenario.eof ? "\r" : scenario.searchProvider ? "custom\r" : `${down.repeat(5)}\r`

  steps.push({ prompt: "Which decision provider should Jevvy use?", input: providerInput })

  if (scenario.eof) return [...steps, { prompt: "Enter your OpenCode Zen API key", input: null }]
  steps.push(
    { prompt: "System One endpoint", input: `${endpoint}\r` },
    { prompt: "Model identifier", input: "fixture-model\r" },
    { prompt: "Does this endpoint require a Bearer API key?", input: scenario.key === undefined ? "n\r" : "y\r" },
  )

  if (scenario.key !== undefined) steps.push({ prompt: "Enter the endpoint API key", input: `${scenario.key}\r` })
  steps.push({ prompt: "Save config and install integrations?", input: scenario.cancelPlan ? "n\r" : "y\r" })

  if (scenario.override !== undefined) steps.push({ prompt: "Continue with this OpenCode CLI anyway?", input: scenario.override ? "y\r" : "n\r" })

  return steps
}

const runScenario = Effect.fn("SetupSmoke.scenario")(function*(permissionsRoot: string, temporary: string, endpoint: string, scenario: Scenario, index: number) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const directory = paths.join(temporary, "interactive setup ü", `${index}-${scenario.name}`)
  const executables = paths.join(directory, "fake commands")
  const home = paths.join(directory, "home")
  const config = paths.join(home, ".config", "jevvy", "jevvy.jsonc")
  const calls = paths.join(directory, "calls.jsonl")
  const state = paths.join(directory, "state.json")
  yield* fs.makeDirectory(executables, { recursive: true })
  yield* fs.makeDirectory(paths.dirname(config), { recursive: true })
  yield* fs.writeFileString(calls, "")
  yield* fs.writeFileString(state, JSON.stringify({ calls, version: scenario.version ?? "2.0.27", installExit: scenario.installExit ?? 0 }))

  if (scenario.existing !== undefined) yield* fs.writeFileString(config, scenario.existing)
  const fixture = paths.join(executables, "fake-host.mjs")
  yield* fs.writeFileString(fixture, fakeHostSource)

  const windowsFixture = windowsHostFixture(process.execPath)

  for (const host of ["opencode", "claude"] as const) {
    if (host === "opencode" && scenario.missing) continue
    const windows = process.platform === "win32"
    const file = paths.join(executables, windows ? `${host}.cmd` : host)
    yield* fs.writeFileString(file, windows
      ? windowsFixture.source(host)
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} ${host} "$@"\n`, { mode: 0o755 })
  }

  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name.toLowerCase() !== "path" && value !== undefined))

  if (process.platform === "win32") Object.assign(env, windowsFixture.environment)

  const environment = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))({
    ...env, [process.platform === "win32" ? "Path" : "PATH"]: executables,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: paths.join(home, ".config"),
    CLAUDE_CONFIG_DIR: paths.join(home, ".claude"), JEVVY_CONFIG: config, JEVVY_SMOKE_STATE: state, NO_COLOR: "1",
  })

  const cancelled = !!(scenario.cancelFirst || scenario.cancelPlan || scenario.eof || scenario.override === false)
  const failed = scenario.expectedCode === 1

  const ending = Match.value({ cancelled, failed }).pipe(
    Match.when({ cancelled: true }, () => "Jevvy Permissions setup cancelled"), Match.when({ failed: true }, () => "Jevvy Permissions setup did not complete"), Match.orElse(() => "Jevvy Permissions is ready for"),
  )

  const result = yield* drive(paths.join(permissionsRoot, "bin", "jevvy.mjs"), directory, environment, planSteps(scenario, endpoint), ending)
  yield* ensure(result.code === (scenario.expectedCode ?? 0), `${scenario.name}: unexpected exit ${result.code} ${result.stderr}`)
  yield* ensure(result.stderr === "", `${scenario.name}: unexpected stderr ${result.stderr}`)
  const rawCalls = yield* fs.readFileString(calls)
  const recorded = yield* Effect.forEach(rawCalls.trim().split("\n").filter(Boolean), (line) => decodeCall(line))
  const installs = recorded.filter(({ args }) => args[0] !== "--version")
  const written = yield* fs.exists(config)

  if (cancelled || scenario.missing && scenario.agents !== "claude") {
    const unchanged = scenario.existing === undefined ? !written : (yield* fs.readFileString(config)) === scenario.existing
    yield* ensure(unchanged, `${scenario.name}: changed config before approval/preflight`)
    yield* ensure(installs.length === 0, `${scenario.name}: installed after cancellation or failed preflight`)
  } else {
    yield* ensure(written, `${scenario.name}: did not save config`)
    const document = yield* decodeConfig(yield* fs.readFileString(config))
    yield* ensure(document.providers.custom.endpoint === endpoint, `${scenario.name}: did not save the chosen provider`)
    yield* ensure(document.providers.custom.apiKey === scenario.key, `${scenario.name}: incorrect credential in config`)

    if (scenario.key !== undefined) yield* ensure(!result.output.includes(scenario.key), "setup displayed a credential")

    if (process.platform !== "win32") yield* ensure(((yield* fs.stat(config)).mode & 0o777) === 0o600, "setup config is not private")
    yield* ensure(JSON.stringify(installs) === JSON.stringify(expectedCommands[scenario.agents]), `${scenario.name}: incorrect installation commands`)
  }

  if (scenario.agents === "claude") yield* ensure(!recorded.some(({ host }) => host === "opencode"), "Claude-only setup inspected OpenCode")

  if (scenario.version === "2.0.26") yield* ensure(result.output.includes("opencode plugin add @jevvy/permissions@0.5.1"), "old CLI warning omitted the manual fallback")

  if (scenario.installExit) yield* ensure(!result.output.includes("Jevvy Permissions is ready"), "failed installation reported success")
  yield* ensure(result.raw.includes("\u001b[?25h"), `${scenario.name}: did not restore the cursor`)
})

export const runInitSmoke = Effect.fn("SetupSmoke.run")(function*(permissionsRoot: string, temporary: string) {
  const requests = yield* Ref.make(0)
  const server = yield* NodeHttpServer.make(() => createServer(), { host: "127.0.0.1", port: 0 })
  yield* server.serve(Ref.update(requests, (count) => count + 1).pipe(Effect.as(HttpServerResponse.text("Setup must not query a provider", { status: 500 }))))
  const endpoint = `${HttpServer.formatAddress(server.address)}/v1/systemone`

  for (const [index, scenario] of cases.entries()) yield* runScenario(permissionsRoot, temporary, endpoint, scenario, index)
  yield* ensure((yield* Ref.get(requests)) === 0, "interactive setup made a provider call")
  yield* Console.log(`Packed interactive setup smoke passed: ${cases.length} scenarios, no provider calls`)
}, Effect.scoped)

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { globalClaudeConfigDirectory } from "../config-path.ts"

const Settings = Schema.fromJsonString(Schema.Struct({
  permissions: Schema.optionalKey(Schema.Struct({
    ask: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
}))

const decodeSettings = Schema.decodeUnknownOption(Settings)

const readSettings = Effect.fn("ClaudeCode.readAskRules")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem

  const raw = yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none<string>())),
    Effect.orElseSucceed(() => undefined),
  )

  if (raw === undefined) return undefined

  if (Option.isNone(raw)) return []

  const decoded = decodeSettings(raw.value)

  return Option.isSome(decoded) ? [...decoded.value.permissions?.ask ?? []] : undefined
})

const repositoryRoot = Effect.fn("ClaudeCode.repositoryRoot")(function*(cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  let current = paths.resolve(cwd)

  while (true) {
    const marker = yield* fs.stat(paths.join(current, ".git")).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.orElseSucceed(() => undefined),
    )

    if (marker === true) return current

    if (marker === undefined) return undefined

    const parent = paths.dirname(current)

    if (parent === current) return false

    current = parent
  }
})

const repositoryPaths = Effect.fn("ClaudeCode.repositorySettingsPaths")(function*(cwd: string) {
  const marker = yield* repositoryRoot(cwd)

  if (marker === false) return []

  if (marker === undefined) return undefined

  const paths = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const output = yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { cwd }))

    return yield* Effect.all({ code: handle.exitCode,
      stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
      stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
    }, { concurrency: "unbounded" })
  })).pipe(Effect.timeout(2000), Effect.orElseSucceed(() => undefined))

  if (output === undefined) return undefined

  if (output.code !== 0) {
    return output.code === 128 && output.stderr.includes("not a git repository") ? [] : undefined
  }

  const [root, common] = output.stdout.trim().split("\n")

  if (root === undefined || common === undefined) return undefined

  const commonRoot = paths.dirname(paths.isAbsolute(common) ? common : paths.resolve(cwd, common))

  return [
    paths.join(root, ".claude", "settings.json"),
    paths.join(root, ".claude", "settings.local.json"),
    paths.join(commonRoot, ".claude", "settings.local.json"),
  ]
})

export const loadAskRules = Effect.fn("ClaudeCode.loadAskRules")(function*(
  cwd: string,
  configDir = globalClaudeConfigDirectory(),
) {
  const path = yield* Path.Path
  const repository = yield* repositoryPaths(cwd)

  if (repository === undefined) return undefined

  const paths = new Set([
    path.join(configDir, "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
    ...repository,
  ])

  const rules: string[] = []

  for (const path of paths) {
    const found = yield* readSettings(path)

    if (found === undefined) return undefined

    rules.push(...found)
  }

  return rules
})

const globMatch = (input: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  const bare = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}(?: .*)?` : escaped

  return new RegExp(`^${bare}$`, "s").test(input)
}

type AskRule =
  | { readonly kind: "review" | "other-tool" | "host" | "host-tool" }
  | { readonly kind: "host-command"; readonly pattern: string }

const classifyAskRule = (rule: string): AskRule => {
  if (rule === "Bash" || rule === "Bash(*)") return { kind: "review" }

  const parsed = /^([^()]+)(?:\((.*)\))?$/.exec(rule)

  if (parsed === null || !/^[A-Za-z0-9_*]+$/.test(parsed[1])) {
    return { kind: rule.includes("Bash") || rule.includes("*") ? "host" : "other-tool" }
  }

  if (!globMatch("Bash", parsed[1])) return { kind: "other-tool" }

  if (parsed[2] === undefined) return { kind: "host-tool" }

  if (/^\s*(?:command|description|timeout|run_in_background)\s*:/.test(parsed[2]) ||
    /^\s*[A-Za-z_][A-Za-z0-9_]*\s+:/.test(parsed[2])) return { kind: "host" }

  const pattern = parsed[2].endsWith(":*") ? `${parsed[2].slice(0, -2)} *` : parsed[2]

  return pattern.trim().length === 0 || /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(pattern)
    ? { kind: "host" }
    : { kind: "host-command", pattern }
}

const isIndirectCommand = (command: string): boolean =>
  /^(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select)(?:\s|$)/.test(command) ||
  /^!\s/.test(command) ||
  /^(?:timeout|time|nice|nohup|stdbuf|command|builtin|noglob|xargs|env)(?:\s|$)/.test(command) ||
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(command)

const literalCommandParts = (command: string): readonly string[] | undefined => {
  if (/[\\'"`$()<>{}]/.test(command)) return undefined

  const parts = command.split(/&&|\|\||[;&|\r\n]/).map((part) => part.trim())

  return parts.every((part) => part.length > 0 && !isIndirectCommand(part)) ? parts : undefined
}

export const inspectAskEligibility = (command: string, rules: readonly string[], reviewAskPatterns: readonly string[] = []): "review" | "host-ask" | "unreliable" => {
  const parts = literalCommandParts(command)
  let unreliable = false

  for (const rule of rules) {
    const ask = classifyAskRule(rule)

    switch (ask.kind) {
      case "review":
      case "other-tool":
        break
      case "host":
        unreliable = true
        break
      case "host-tool":
        if (!reviewAskPatterns.includes(rule)) return "host-ask"
        break
      case "host-command":
        if (parts === undefined) unreliable = true
        else if (!reviewAskPatterns.includes(rule) &&
          (globMatch(command, ask.pattern) || parts.some((part) => globMatch(part, ask.pattern)))) return "host-ask"
    }
  }

  return unreliable ? "unreliable" : "review"
}

export const hasHostAsk = (command: string, rules: readonly string[], reviewAskPatterns: readonly string[] = []): boolean =>
  inspectAskEligibility(command, rules, reviewAskPatterns) !== "review"

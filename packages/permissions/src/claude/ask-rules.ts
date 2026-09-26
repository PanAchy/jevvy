import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"
import { Effect, Option, Schema } from "effect"

const exec = promisify(execFile)

const Settings = Schema.fromJsonString(Schema.Struct({
  permissions: Schema.optionalKey(Schema.Struct({
    ask: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
}))

const decodeSettings = Schema.decodeUnknownOption(Settings)

const readSettings = Effect.fn("ClaudeCode.readAskRules")(function*(path: string) {
  const raw = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(Effect.match({
    onFailure: (cause) => ({ kind: "error" as const, cause }),
    onSuccess: (text) => ({ kind: "found" as const, text }),
  }))

  if (raw.kind === "error") {
    if (raw.cause instanceof Error && "code" in raw.cause && raw.cause.code === "ENOENT") return []

    return undefined
  }

  const decoded = decodeSettings(raw.text)

  return Option.isSome(decoded) ? [...decoded.value.permissions?.ask ?? []] : undefined
})

const repositoryRoot = Effect.fn("ClaudeCode.repositoryRoot")(function*(cwd: string) {
  let current = resolve(cwd)

  while (true) {
    const marker = yield* Effect.tryPromise({
      try: () => stat(join(current, ".git")),
      catch: (cause) => cause,
    }).pipe(Effect.match({
      onFailure: (cause) => cause,
      onSuccess: () => true,
    }))

    if (marker === true) return current

    if (!(marker instanceof Error && "code" in marker && marker.code === "ENOENT")) return undefined

    const parent = dirname(current)

    if (parent === current) return false

    current = parent
  }
})

const repositoryPaths = Effect.fn("ClaudeCode.repositorySettingsPaths")(function*(cwd: string) {
  const marker = yield* repositoryRoot(cwd)

  if (marker === false) return []

  if (marker === undefined) return undefined

  const output = yield* Effect.tryPromise({
    try: () => exec("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { cwd }),
    catch: (cause) => cause,
  }).pipe(Effect.match({
    onFailure: (cause) => ({ kind: "error" as const, cause }),
    onSuccess: (value) => ({ kind: "found" as const, value }),
  }))

  if (output.kind === "error") {
    if (output.cause instanceof Error && "code" in output.cause && output.cause.code === 128 &&
      "stderr" in output.cause && String(output.cause.stderr).includes("not a git repository")) return []

    return undefined
  }

  const [root, common] = output.value.stdout.trim().split("\n")

  if (root === undefined || common === undefined) return undefined

  const commonRoot = dirname(isAbsolute(common) ? common : resolve(cwd, common))

  return [
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
    join(commonRoot, ".claude", "settings.local.json"),
  ]
})

export const loadAskRules = Effect.fn("ClaudeCode.loadAskRules")(function*(
  cwd: string,
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
) {
  const repository = yield* repositoryPaths(cwd)

  if (repository === undefined) return undefined

  const paths = new Set([
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
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

const controlFlow = /^(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select)(?:\s|$)/

const simpleCommands = (command: string): readonly string[] | undefined => {
  if (/[\\'"`$()<>{}]/.test(command)) return undefined

  const parts = command.split(/&&|\|\||[;&|\r\n]/).map((part) => part.trim())

  // Claude can match ask rules inside control-flow bodies. These fragments
  // are not independent commands, so we cannot safely match them ourselves.
  if (parts.some((part) => controlFlow.test(part) || /^!\s/.test(part))) {
    return undefined
  }

  return parts.every((part) => part.length > 0) ? parts : undefined
}

export const mustPromptForAskRule = (command: string, rules: readonly string[]): boolean => {
  const parts = simpleCommands(command)
  let hasBashAsk = false

  for (const rule of rules) {
    const parsed = /^([^()]+)(?:\((.*)\))?$/.exec(rule)

    if (parsed === null) {
      if (rule.includes("Bash") || rule.includes("*")) return true

      continue
    }

    if (!globMatch("Bash", parsed[1])) continue

    hasBashAsk = true

    if (parsed[2] === undefined) return true

    const pattern = parsed[2].endsWith(":*") ? `${parsed[2].slice(0, -2)} *` : parsed[2]

    // Rules matching tool-input parameters need the whole Bash input, not just its command.
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(pattern)) return true

    if (globMatch(command, pattern) || parts?.some((part) => globMatch(part, pattern))) return true
  }

  if (!hasBashAsk) return false

  // Substitutions and wrappers can cause a host rule to match a different
  // command than the literal text checked above.
  if (parts === undefined) return true

  if (parts.some((part) => /^(?:timeout|time|nice|nohup|stdbuf|command|builtin|noglob|xargs|env)(?:\s|$)/.test(part))) return true

  if (parts.some((part) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(part))) return true

  return false
}

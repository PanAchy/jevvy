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

type AskRule =
  | { readonly kind: "review" | "other-tool" | "host" }
  | { readonly kind: "host-command"; readonly pattern: string }

const classifyAskRule = (rule: string): AskRule => {
  if (rule === "Bash" || rule === "Bash(*)") return { kind: "review" }

  const parsed = /^([^()]+)(?:\((.*)\))?$/.exec(rule)

  if (parsed === null) {
    return { kind: rule.includes("Bash") || rule.includes("*") ? "host" : "other-tool" }
  }

  if (!globMatch("Bash", parsed[1])) return { kind: "other-tool" }

  if (parsed[2] === undefined) return { kind: "host" }

  const pattern = parsed[2].endsWith(":*") ? `${parsed[2].slice(0, -2)} *` : parsed[2]

  return /^[A-Za-z_][A-Za-z0-9_]*:/.test(pattern)
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

export const hasHostAsk = (command: string, rules: readonly string[]): boolean => {
  const parts = literalCommandParts(command)

  return rules.some((rule) => {
    const ask = classifyAskRule(rule)

    switch (ask.kind) {
      case "review":
      case "other-tool":
        return false
      case "host":
        return true
      case "host-command":
        return parts === undefined || globMatch(command, ask.pattern) ||
          parts.some((part) => globMatch(part, ask.pattern))
    }
  })
}

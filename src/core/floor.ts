// Code tiers that run before any model call - deterministic, private, free.
// Order matters: floor (loud ask) -> credential shape (ask, never sent to the API) -> proven (allow).

export interface FloorRule {
  readonly pattern: RegExp
  readonly reason: string
}

/** Catastrophic commands. Escalated to the user without consulting the model. */
export const DENY_FLOOR: readonly FloorRule[] = [
  { pattern: /(^|\s)rm\s+(-{1,2}[A-Za-z][A-Za-z-]*\s+)+\/(\s|$)/, reason: "rm -rf targeting filesystem root" },
  { pattern: /:\(\)\{ :\|:& \};:/, reason: "fork bomb" },
  { pattern: /(^|\s)(curl|wget)\b[^|;]*\|\s*(ba|z)?sh\b/, reason: "downloads a script and pipes it into a shell" },
  { pattern: /(^|\s)mkfs(\.\w+)?\b|dd\b[^;]*of=\/dev\//, reason: "formats or raw-writes a disk device" },
  { pattern: /(^|\s)chmod\s+-R\s+[0-7]*7[0-7]*\s+\/(\s|$)/, reason: "recursive world-writable chmod on root" },
]

/**
 * Credential-shaped commands are stopped in code and never sent to the API -
 * the privacy tier. `ask`, not `deny`: the user may well mean it.
 */
export const CREDENTIAL_PATTERNS: readonly FloorRule[] = [  { pattern: /\btsk-[A-Za-z0-9_-]{8,}/, reason: "contains a TypeSafe API key shape" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/, reason: "contains a private key block" },
  { pattern: /AKIA[0-9A-Z]{16}/, reason: "contains an AWS access key shape" },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/, reason: "contains a GitHub token shape" },
  { pattern: /(^|[\s_"'-])(password|passwd|secret(?:[_a-z]*key)?|api[_-]?key|[a-z0-9_]*token)\s*[:=]\s*\S+/i, reason: "assigns a credential-shaped value" },
]

/**
 * Proven allowlist - every segment a listed read-only verb, nothing sent anywhere.
 * Keep it deliberately tiny; three plain rules beat the model on real traffic.
 */
export const PROVEN_PREFIXES: readonly string[] = [
  "cd ",
  "cd",
  "ls",
  "pwd",
  "head ",
  "tail ",
  "echo ",
  "which ",
  "true",
  "sleep ",
  "wc ",
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git show",
  "git stash list",
  "node --version",
  "npm ls",
  "sed -n",
]

/**
 * A segment carrying any of these is not proven read-only, whatever its
 * first word: redirections write files, substitution and backticks run
 * nested commands the scanner never sees.
 */
const PROVEN_BLOCKERS = /[>$`]|\$\(/

/**
 * Strip bash comments before any tier or the judge sees the command:
 * "nothing a command says about itself can help it" (jevgate). Quote-aware
 * by scanning, not regex: a `#` inside quotes is text and must survive, or
 * a quoted hash could swallow a dangerous tail into an apparent no-op.
 */
export const stripComments = (command: string): string => {
  let result = ""
  let quote: '"' | "'" | undefined

  for (let index = 0; index < command.length; index++) {
    const char = command[index]

    if (quote !== undefined) {
      result += char

      if (char === quote) quote = undefined

      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      result += char

      continue
    }

    const startsComment = char === "#" && (index === 0 || /\s/.test(command[index - 1] ?? ""))

    if (startsComment) return result.trimEnd()

    result += char
  }

  return result.trim()
}

/**
 * Redact credential-shaped substrings before a command is persisted or shown.
 * The credential tier exists to keep secrets away from the model; the same
 * duty applies to the decision log.
 */
export const redactSecrets = (command: string): string =>
  CREDENTIAL_PATTERNS.reduce(
    (redacted, { pattern }) => redacted.replace(new RegExp(pattern.source, withGlobal(pattern)), "[redacted]"),
    command,
  )

const withGlobal = (pattern: RegExp): string => (pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)

/**
 * Classify a command whose resources arrive pre-split by the host scanner.
 * Each resource is classified independently (per-resource comment stripping
 * cannot eat its siblings) and the strictest tier wins: floor > credential >
 * unknown > proven. Joining with a separator first was a bug: an inserted
 * semicolon could pose as a credential value, and a comment in an early
 * resource could hide a later dangerous one.
 */
const TIER_STRICTNESS = { floor: 3, credential: 2, unknown: 1, proven: 0 } as const

export const classifySegments = (segments: readonly string[]): CodeTier => {
  let strictest: CodeTier = { tier: "proven", reason: "every segment is a listed read-only verb" }

  for (const segment of segments) {
    if (segment.trim().length === 0) continue

    const tier = classifyCodeTiers(segment)

    if (tier.tier === "floor") return tier

    if (TIER_STRICTNESS[tier.tier] > TIER_STRICTNESS[strictest.tier]) strictest = tier
  }

  return strictest
}

/**
 * What the judge and the logs see: each resource stripped of its own
 * comments, then joined. Order preserved, comments per-segment.
 */
export const joinForJudge = (segments: readonly string[]): string => {
  const stripped: string[] = []

  for (const segment of segments) {
    const cleaned = stripComments(segment)

    if (cleaned.length > 0) stripped.push(cleaned)
  }

  return stripped.join(" ; ")
}

export type CodeTier =
  | { readonly tier: "floor"; readonly reason: string }
  | { readonly tier: "credential"; readonly reason: string }
  | { readonly tier: "proven"; readonly reason: string }
  | { readonly tier: "unknown" }

/**
 * Evaluate the code tiers for a compound command. Segments split on statement
 * separators and pipes; every segment must be proven for the proven verdict;
 * any floor/credential hit wins. Quoted separators inside arguments are split
 * too: full bash tokenization is out of scope.
 */
export const classifyCodeTiers = (rawCommand: string): CodeTier => {
  const command = stripComments(rawCommand)
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean)

  for (const { pattern, reason } of DENY_FLOOR) {
    if (pattern.test(command)) return { tier: "floor", reason }
  }

  for (const { pattern, reason } of CREDENTIAL_PATTERNS) {
    if (pattern.test(command)) return { tier: "credential", reason }
  }

  const allProven =
    segments.length > 0 &&
    segments.every(
      (segment) =>
        !PROVEN_BLOCKERS.test(segment) &&
        PROVEN_PREFIXES.some((prefix) => segment === prefix.trim() || segment.startsWith(prefix)),
    )

  if (allProven) {
    return { tier: "proven", reason: "every segment is a listed read-only verb" }
  }

  return { tier: "unknown" }
}

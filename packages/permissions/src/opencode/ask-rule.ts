interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

const matches = (input: string, pattern: string): boolean => {
  const normalized = input.replaceAll("\\", "/")

  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

export const hasExplicitAsk = (
  action: string,
  resources: readonly string[],
  rules: readonly Rule[],
): boolean => resources.some((resource) => {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]

    if (matches(action, rule.action) && matches(resource, rule.resource)) return rule.effect === "ask"
  }

  return false
})

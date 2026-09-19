// OpenCode evaluates saved approvals before plugin permission hooks, but the
// hook event does not say which rule matched. Jevvy checks the host's saved
// approval list so an explicit "always" is not turned back into an ask.

export interface SavedApproval {
  readonly action: string
  readonly resource: string
}

const escapeRegex = (text: string): string => text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")

const wildcardFragment = (character: string): string => {
  switch (character) {
    case "*":
      return "[\\s\\S]*"
    case "?":
      return "[\\s\\S]"
    default:
      return escapeRegex(character)
  }
}

/** Match OpenCode's whole-value `*` and `?` wildcards. Shell prefixes ending
 *  in ` *` also cover the command without arguments. */
export const matchesApprovalPattern = (pattern: string, resource: string, shell = false): boolean => {
  const optionalArguments = shell && pattern.endsWith(" *")

  const body = optionalArguments ? pattern.slice(0, -2) : pattern

  const expression = [...body].map(wildcardFragment).join("")

  const suffix = optionalArguments ? "(?: [\\s\\S]*)?" : ""

  return new RegExp(`^${expression}${suffix}$`, "u").test(resource)
}

/** Every scanner resource must be covered by a saved approval for the action. */
export const isRememberedApproval = (
  approvals: readonly SavedApproval[],
  action: string,
  resources: readonly string[],
): boolean =>
  resources.length > 0 &&
  resources.every((resource) =>
    approvals.some((approval) =>
      approval.action === action && matchesApprovalPattern(approval.resource, resource, action === "shell"),
    ),
  )

// OpenCode evaluates saved approvals before plugin permission hooks, but the
// hook event does not say which rule matched. Jevvy checks the host's saved
// approval list so an explicit "always" is not turned back into an ask.

export interface SavedApproval {
  readonly action: string
  readonly resource: string
}

const escapeRegex = (text: string): string => text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")

/** OpenCode save patterns use `*`; matching stays anchored and conservative. */
export const matchesApprovalPattern = (pattern: string, resource: string): boolean => {
  const expression = pattern.split("*").map(escapeRegex).join("[\\s\\S]*")

  return new RegExp(`^${expression}$`, "u").test(resource)
}

/** Every scanner resource must be covered by a saved approval for the action. */
export const isRememberedApproval = (
  approvals: readonly SavedApproval[],
  action: string,
  resources: readonly string[],
): boolean =>
  resources.length > 0 &&
  resources.every((resource) =>
    approvals.some((approval) => approval.action === action && matchesApprovalPattern(approval.resource, resource)),
  )

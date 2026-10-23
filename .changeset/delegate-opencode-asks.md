---
"@jevvy/permissions": minor
---

### Permission behavior

Add opt-in `permissions.reviewAskPatterns` so Jevvy Permissions can review OpenCode shell asks from existing catch-all or specific rules. Entries identify winning ask rules by exact resource-pattern string, not commands to approve. Unlisted asks and final host allow/deny decisions remain untouched. The existing shell review invitation and default behavior are unchanged; reload OpenCode after changing the list. Claude Code behavior is unchanged.

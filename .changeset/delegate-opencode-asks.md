---
"@jevvy/permissions": minor
---

### Permission behavior

Add opt-in `permissions.reviewAskPatterns: { opencode: [], claude: [] }` so Jevvy Permissions can review nominated shell asks in either host. OpenCode entries identify winning ask resource-pattern strings; Claude Code entries identify complete visible `permissions.ask` strings such as `Bash(git *)`. Nominations are exact and host-scoped, not commands to approve. Matching non-nominated Claude asks remain host-owned regardless of ordering, and uncertain selectors or command matching still cause abstention. Claude inspection covers visible settings, not managed, CLI or session rules. Existing review invitations, empty-list behavior and final host allow/deny decisions are unchanged. Reload OpenCode after changing its list; Claude reads its list on each hook invocation.

---
"@jevvy/permissions": patch
---

### Permission behavior

Treat Claude Code's exact `Bash` and `Bash(*)` catch-all ask rules as invitations to Jevvy review, matching OpenCode's shell catch-all behavior. Preserve other matching configured asks for the host. Jevvy abstention leaves native prompting or automatic acceptance unchanged.

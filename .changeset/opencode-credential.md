---
"@jevvy/permissions": minor
---

Reuse an API key from an OpenCode integration with `providers.<name>.opencodeCredential`, as an explicit fallback after Jevvy Permissions configuration and provider environment variables. Account-login OAuth credentials are skipped without retrieving or refreshing them. Claude Code credential handling is unchanged.

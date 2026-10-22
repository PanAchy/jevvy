---
"@jevvy/permissions": minor
---

### Configuration

Add default-off `metrics.enabled` for bounded OpenCode plugin-instance aggregate JSON in the global Jevvy `metrics/` directory, with a JSON schema and agent instructions. Seven-day aggregate windows roll over automatically; enabled maintenance removes expired data and reclaims closed writers. Storage failures and active-writer contention report diagnostics and retry without changing reviews. The initial persistence integration is POSIX-only; Windows opt-in reports an actionable diagnostic. No command history or cumulative Claude Code metrics are collected.

---
"@jevvy/permissions": minor
---

### Configuration

Add default-off `metrics.enabled` for local Jevvy Permissions OpenCode and Claude Code per-review history. Verbatim commands and raw answers may contain secrets. Both integrations share the private global `metrics/history.sqlite`, its schema and agent instructions for read-only reporting. No dashboard, export or telemetry is added.

History retains newest records within 10,000 rows, 16 MiB logical event bytes and a 32 MiB main database, with extra temporary rollback-journal space. There is no age expiry; fourteen days is only a possible query timeframe. Capacity eviction, drops and storage failures make coverage incomplete. Disabling does not erase existing records. Background storage cannot change permission verdicts. Initial persistence is POSIX-only; OpenCode surfaces setup diagnostics, and Claude Code reports permanent privacy/platform setup failures at SessionStart without opening or creating a database. Claude permission-request storage failures remain silent. Claude Code uses a standalone bundled worker with a best-effort 500 ms final drain per invocation, without a daemon or external dependencies.

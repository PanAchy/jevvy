---
"@jevvy/permissions": minor
---

### Configuration

Add default-off `metrics.history.enabled` for local Jevvy Permissions OpenCode per-review history. Verbatim commands and raw answers may contain secrets. Legacy `metrics.enabled` never enables history. The private global `metrics/` directory contains `history.sqlite`, its schema and agent instructions for read-only reporting. No dashboard, export or telemetry is added.

History retains newest records within 10,000 rows, 16 MiB logical event bytes and a 32 MiB main database, with extra temporary rollback-journal space. There is no age expiry; fourteen days is only a possible query timeframe. Capacity eviction, drops and storage failures make coverage incomplete. Disabling does not erase existing records. Background storage cannot change permission verdicts. Initial persistence is POSIX-only, with an actionable Windows diagnostic. Claude Code behavior and its dependency-free hook remain unchanged.

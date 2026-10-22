---
"@jevvy/permissions": minor
---

### Configuration

Add default-off `metrics.enabled` for recent, best-effort OpenCode review counts and shipped-question abstention reasons in the global Jevvy `metrics/` directory. A generated JSON schema and short agent instructions support user-generated reports without a built-in dashboard, timing analysis or command history. Counts distinguish approvals, policy abstentions and unavailable judgments; custom question names and raw scores are not stored.

Aggregate windows expire after seven days, but writer eviction can remove entries earlier, so retained counts are not complete weekly totals. Enabled maintenance removes expired entries; storage failures retry without changing reviews. Initial persistence is POSIX-only, with an actionable diagnostic for Windows opt-in. Claude Code behavior is unchanged.

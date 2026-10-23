---
"@jevvy/permissions": patch
---

### Reliability

Keep Claude Code review history scoped to one worker attempt per invocation, while OpenCode starts storage on its first observation and retains background recovery. Storage readiness adds no separate permission-response wait; unfinished startup shares the existing 500 ms final drain.

Retry transient SQLite rollback-journal unlink or replacement races after rechecking private paths, instead of treating legitimate concurrent writes as permanently unsafe. Database identity and filesystem privacy checks remain strict. History is still best effort and cannot change permission decisions.

Reduce repeated history-worker startup work with bundled schema-only imports and build-generated metadata. Skip the capacity eviction window when transactional row and byte totals are already within bounds. Existing metadata bytes, storage validation, durability and capacity limits are unchanged; contention can still drop observations.

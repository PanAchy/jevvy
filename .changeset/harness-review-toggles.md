---
"@jevvy/permissions": minor
---

### Configuration

Add independent persistent review controls for OpenCode and Claude Code through `/jevvy`. Store each harness's enabled setting in the global `jevvy.jsonc`; existing configurations remain enabled by default.

### Permission behavior

Turning Jevvy OFF skips new reviews and cached approvals without changing the host's permission handling. Reviews already started finish normally. Turning Jevvy back ON resumes review.

### Reliability

Show a text-only green/red Jevvy indicator with a brief blink when the setting changes. Reflect changes from other sessions and configuration edits without restarting. Serialize configuration updates across processes and initialization, keep credential-bearing writes private, and recover expired writer locks.

---
"@jevvy/permissions": patch
---

Check selected harness CLIs before saving setup configuration. Recognize OpenCode's `opencode v2.0.27` version output. Warn when the OpenCode CLI is older than 2.0.27 or its version cannot be verified, default to cancellation, and require an explicit override to continue. Keep the latest install command unchanged and provide manual guidance rather than automatically pinning or downgrading. Reuse setup's Windows command-wrapper support for version inspection.

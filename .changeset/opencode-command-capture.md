---
"@jevvy/permissions": patch
---

Match OpenCode shell invocations by command text so permission reviews work on OpenCode 2.4, where `tool.execute.before` and `shell.create.before` run on different Effect fibers.

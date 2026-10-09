---
"@jevvy/permissions": patch
---

Restore OpenCode shell review when the winning permission rule is exactly `shell / * / ask`. Specific asks remain human-only, existing allows bypass review, and denies stay blocked. Jevvy approves only the current action; uncertainty or provider failure leaves the human prompt intact.

Show the required catch-all ask baseline after interactive setup without changing existing permission rules. Add real-host coverage that verifies shell commands reach a local provider.

Update the OpenCode plugin dependency to 2.0.26 and test the real shell flow on 2.0.18 and 2.0.26. Keep Effect pinned to the version bundled by OpenCode.

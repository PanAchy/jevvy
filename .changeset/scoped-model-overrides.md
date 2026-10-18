---
"@jevvy/permissions": minor
---

### Configuration

Choose a model for OpenCode Zen, TypeSafe AI, OpenRouter, or Vercel AI Gateway with `providers.<provider>.model`. Jevvy Permissions sends the exact identifier without fallback and preserves it during setup.

Zen now defaults to the paid, billable `jev-1.13` route. Set `providers.zen.model` to `"jev-1.13-free"` to retain the limited-time free route. Paid Zen and other unverified overrides retain shipped questions without inheriting calibration attribution.

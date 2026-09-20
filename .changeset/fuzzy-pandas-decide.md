---
"@jevvy/permissions": minor
---

## New providers

Connect Jevvy to any System One-compatible HTTP endpoint with a configurable endpoint URL, model ID, and optional Bearer API key. This includes authenticated hosted routes and compatible local servers.

## Configuration

Add `jevvy init`, an interactive setup workflow that configures a provider, stores credentials in the protected global Jevvy file, and installs the selected harness integration.

## Breaking changes

Remove automatic provider selection. Jevvy now requires an explicit `provider` in `~/.config/jevvy/jevvy.jsonc`. Existing installations using `provider: "auto"` must run `npx @jevvy/permissions init` or select a provider manually. Until configuration and required credentials are available, OpenCode reports Jevvy as failed and its remaining permission flow continues unchanged.

Custom approval policies now use a numeric `threshold` directly on each question. Replace an `atMost` threshold object with its numeric `value`. Custom Inquiries must describe reasons for human review, so lower answers pass; rewrite and recalibrate policies that previously used `atLeast`.

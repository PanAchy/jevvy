# @jevvy/permissions

## 0.4.0

Jevvy 0.4.0 adds Claude Code permission review, multi-harness setup, and Node.js 22 support while preserving each coding agent's native permission flow whenever Jevvy abstains.

### New harnesses

- [#24](https://github.com/PanAchy/jevvy/pull/24) [`5073e5d`](https://github.com/PanAchy/jevvy/commit/5073e5dcd9b151bb2b1d123524069c24e4c50398) - Add a Claude Code plugin that reviews Bash `PermissionRequest` events and grants one-action approval only when every Jevvy inquiry passes. All uncertain and unavailable outcomes leave Claude Code's remaining permission flow unchanged.

### Configuration

- [#24](https://github.com/PanAchy/jevvy/pull/24) [`5073e5d`](https://github.com/PanAchy/jevvy/commit/5073e5dcd9b151bb2b1d123524069c24e4c50398) - Let `jevvy init` install OpenCode, Claude Code, or both from one multi-select setup flow.

- [#24](https://github.com/PanAchy/jevvy/pull/24) [`5073e5d`](https://github.com/PanAchy/jevvy/commit/5073e5dcd9b151bb2b1d123524069c24e4c50398) - Report invalid Jevvy configuration and missing provider credentials when a Claude Code session starts, without changing any permission decision.

### Reliability

- [#24](https://github.com/PanAchy/jevvy/pull/24) [`5073e5d`](https://github.com/PanAchy/jevvy/commit/5073e5dcd9b151bb2b1d123524069c24e4c50398) - Support Node.js 22.19 and newer for setup, provider review, and Claude Code hooks.

### Fixes

- [#24](https://github.com/PanAchy/jevvy/pull/24) [`5073e5d`](https://github.com/PanAchy/jevvy/commit/5073e5dcd9b151bb2b1d123524069c24e4c50398) - Correct the MIT license attribution in the repository and published package.

### Breaking changes

- [#24](https://github.com/PanAchy/jevvy/pull/24) [`5073e5d`](https://github.com/PanAchy/jevvy/commit/5073e5dcd9b151bb2b1d123524069c24e4c50398) - Stop reading OpenCode login credentials for OpenCode Zen. Every harness now uses the selected provider's API key from the global Jevvy configuration or its native environment variable.

## 0.3.0

Jevvy 0.3.0 adds assisted setup and custom System One providers, with explicit provider selection and clearer setup guidance.

### New providers

- [#21](https://github.com/PanAchy/jevvy/pull/21) [`1c18ec3`](https://github.com/PanAchy/jevvy/commit/1c18ec362359242adc91f178f2ed6f9730c28bee) - Connect Jevvy to any System One-compatible HTTP endpoint with a configurable endpoint URL, model ID, and optional Bearer API key. This includes authenticated hosted routes and compatible local servers.

### Configuration

- [#21](https://github.com/PanAchy/jevvy/pull/21) [`1c18ec3`](https://github.com/PanAchy/jevvy/commit/1c18ec362359242adc91f178f2ed6f9730c28bee) - Add `jevvy init`, an interactive setup workflow that configures a provider, stores credentials in the protected global Jevvy file, and installs the selected harness integration.

- [#23](https://github.com/PanAchy/jevvy/pull/23) [`aeb5760`](https://github.com/PanAchy/jevvy/commit/aeb57602bfaffacf8d7bfee6d254193de5452502) - Clarify that missing provider setup can be completed with either `jevvy init` or a manually created global configuration file.

### Breaking changes

- [#21](https://github.com/PanAchy/jevvy/pull/21) [`1c18ec3`](https://github.com/PanAchy/jevvy/commit/1c18ec362359242adc91f178f2ed6f9730c28bee) - Remove automatic provider selection. Jevvy now requires an explicit `provider` in `~/.config/jevvy/jevvy.jsonc`. Existing installations using `provider: "auto"` must run `npx @jevvy/permissions init` or select a provider manually. Until configuration and required credentials are available, OpenCode reports Jevvy as failed and its remaining permission flow continues unchanged.

- [#21](https://github.com/PanAchy/jevvy/pull/21) [`1c18ec3`](https://github.com/PanAchy/jevvy/commit/1c18ec362359242adc91f178f2ed6f9730c28bee) - Custom approval policies now use a numeric `threshold` directly on each question. Replace an `atMost` threshold object with its numeric `value`. Custom Inquiries must describe reasons for human review, so lower answers pass. Rewrite and recalibrate policies that previously used `atLeast`.

## 0.2.0

Jevvy 0.2.0 expands provider choice and strengthens provider failure handling without changing its abstention-first permission behavior.

### New providers

- [#17](https://github.com/PanAchy/jevvy/pull/17) [`582c7bd`](https://github.com/PanAchy/jevvy/commit/582c7bd6e6cc77b9e01297d8330c4065c14e2b02) - Add OpenRouter as a configurable Jev provider through its TypeSafe-compatible System One endpoint.

- [#18](https://github.com/PanAchy/jevvy/pull/18) [`0e50d79`](https://github.com/PanAchy/jevvy/commit/0e50d7985d39da2e2c9785e269f7f4a94ecf7e84) - Add Vercel AI Gateway as a supported provider.

### Reliability

- [#10](https://github.com/PanAchy/jevvy/pull/10) [`ed85087`](https://github.com/PanAchy/jevvy/commit/ed850872abd89efedba5d44fcf286a42fac37007) - Use one Effect runtime throughout provider evaluation, permission review, OpenCode integration, and calibration, with typed provider failures that preserve native permission prompts when Jevvy cannot decide.

- [#12](https://github.com/PanAchy/jevvy/pull/12) [`1bf3bf8`](https://github.com/PanAchy/jevvy/commit/1bf3bf8beb1e922f4239c75b6380fcb66cdd32db) - Report structured provider failures in OpenCode server logs and apply bounded provider cooldowns after rate limits or exhausted credits while preserving native permission prompts.

### Provider infrastructure

- [#13](https://github.com/PanAchy/jevvy/pull/13) [`a1047a4`](https://github.com/PanAchy/jevvy/commit/a1047a45eddab82ae762beab842ca8e082c3301a) - Send provider requests through Effect HTTP with Schema-backed JSON encoding and decoding, and document a copyable TypeSafe API key configuration.

## 0.1.0

### Minor Changes

- [`e2e88ed`](https://github.com/PanAchy/jevvy/commit/e2e88ed7583a55d5ff479f3e529a0f5232083f03) - Release Jevvy's OpenCode permission reviewer with calibrated harmless-command approval, global provider configuration, custom policy calibration, and abstention-safe failure behavior.

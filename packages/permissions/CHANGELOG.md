# @jevvy/permissions

## 0.3.0

### Minor Changes

- [#21](https://github.com/PanAchy/jevvy/pull/21) [`1c18ec3`](https://github.com/PanAchy/jevvy/commit/1c18ec362359242adc91f178f2ed6f9730c28bee) - ## New providers
  
  Connect Jevvy to any System One-compatible HTTP endpoint with a configurable endpoint URL, model ID, and optional Bearer API key. This includes authenticated hosted routes and compatible local servers.
  
  ## Configuration
  
  Add `jevvy init`, an interactive setup workflow that configures a provider, stores credentials in the protected global Jevvy file, and installs the selected harness integration.
  
  ## Breaking changes
  
  Remove automatic provider selection. Jevvy now requires an explicit `provider` in `~/.config/jevvy/jevvy.jsonc`. Existing installations using `provider: "auto"` must run `npx @jevvy/permissions init` or select a provider manually. Until configuration and required credentials are available, OpenCode reports Jevvy as failed and its remaining permission flow continues unchanged.
  
  Custom approval policies now use a numeric `threshold` directly on each question. Replace an `atMost` threshold object with its numeric `value`. Custom Inquiries must describe reasons for human review, so lower answers pass; rewrite and recalibrate policies that previously used `atLeast`.

### Patch Changes

- [#23](https://github.com/PanAchy/jevvy/pull/23) [`aeb5760`](https://github.com/PanAchy/jevvy/commit/aeb57602bfaffacf8d7bfee6d254193de5452502) - ## Configuration
  
  Clarify that missing provider setup can be completed with either `jevvy init` or a manually created global configuration file.

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

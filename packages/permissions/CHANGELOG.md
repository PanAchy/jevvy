# @jevvy/permissions

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

# @jevvy/permissions

## 0.9.0

### New providers

- [#70](https://github.com/PanAchy/jevvy/pull/70) [`73adf25`](https://github.com/PanAchy/jevvy/commit/73adf252d0e4a28304b1dcd31017bf79a68e2fa1) - Add Cloudflare Clef and Clef-flash support for both harnesses. Each model needs its own calibration; requests over 8 KiB abstain rather than risk command truncation.

### Permission behavior

- [#69](https://github.com/PanAchy/jevvy/pull/69) [`0b1f0bc`](https://github.com/PanAchy/jevvy/commit/0b1f0bc3cb235199ca8369332a4fa46921da6154) - Add a red/green Jevvy indicator with click-to-toggle controls in the session header for OpenCode Desktop 2.2.0 or newer through its experimental GUI API. `/jevvy` remains available without the GUI.

### Reliability

- [#76](https://github.com/PanAchy/jevvy/pull/76) [`24b350c`](https://github.com/PanAchy/jevvy/commit/24b350c7c622d4c72cd351ee5a67fb78d8230ef1) - Retry brief history storage contention during worker startup so concurrent Claude Code hooks keep their observations.

### Fixes

- [#75](https://github.com/PanAchy/jevvy/pull/75) [`79a8146`](https://github.com/PanAchy/jevvy/commit/79a81462c252b9b8f0948c2cd0dab137d6d8cd09), [#70](https://github.com/PanAchy/jevvy/pull/70) [`73adf25`](https://github.com/PanAchy/jevvy/commit/73adf252d0e4a28304b1dcd31017bf79a68e2fa1) - Describe Microsoft Decision as a setup guide after a live compatibility check. Model-specific calibration remains required.

- [#68](https://github.com/PanAchy/jevvy/pull/68) [`7f0f516`](https://github.com/PanAchy/jevvy/commit/7f0f516cd76e188c7d6946dc165cb913a1e0e30b) Thanks [@dependabot](https://github.com/apps/dependabot)! - Update the locked Undici dependency to 8.12.3 for upstream TLS and HTTP security fixes.

## 0.8.0

### New providers

- [#53](https://github.com/PanAchy/jevvy/pull/53) [`3294e69`](https://github.com/PanAchy/jevvy/commit/3294e69d45d9628847dcc3229bda7384d425a817) - Add OpenAI Decisions (`gpt-6-luna`) and Microsoft-Decision-1 via Azure Foundry. Non-Jev models require their own calibration.

### Permission behavior

- [#67](https://github.com/PanAchy/jevvy/pull/67) [`f66ac99`](https://github.com/PanAchy/jevvy/commit/f66ac994c580f31517259e22fd2102befc8e429a) - Let Jevvy Permissions review selected shell ask rules with `permissions.reviewAskPatterns`. Nominations are exact and host-scoped. Other host asks and finalized allow/deny decisions stay unchanged. Claude inspects visible settings only.

### Configuration

- [#64](https://github.com/PanAchy/jevvy/pull/64) [`892a954`](https://github.com/PanAchy/jevvy/commit/892a954c97739f2fb0c9adddb9de9db009076b12) - Enable private local review history for both hosts with `"metrics": { "enabled": true }` in global configuration. Off by default, POSIX-only and best effort; it never changes permission decisions. **Verbatim commands and raw answers may contain secrets.** Disabling history does not erase records.

- [#63](https://github.com/PanAchy/jevvy/pull/63) [`0673cbf`](https://github.com/PanAchy/jevvy/commit/0673cbf1fe57dbc3b4f34db8bf760bc21f61c6ec) Thanks [@futafi](https://github.com/futafi)! - Explicitly reuse an OpenCode API key with `providers.<name>.opencodeCredential` after global credentials and environment variables. OAuth connections are skipped; Claude credentials are unchanged.

### Reliability

- [#67](https://github.com/PanAchy/jevvy/pull/67) [`f66ac99`](https://github.com/PanAchy/jevvy/commit/f66ac994c580f31517259e22fd2102befc8e429a) - Update the OpenCode SDK to 2.1.3, retaining OpenCode 2.0.27+ support. Claude-only use does not require OpenCode.

### Fixes

- [#53](https://github.com/PanAchy/jevvy/pull/53) [`3294e69`](https://github.com/PanAchy/jevvy/commit/3294e69d45d9628847dcc3229bda7384d425a817) - Fix custom-question encoding and Microsoft deployment calibration. Add provider-name filtering during setup.

## 0.7.0

### Breaking changes

- [#61](https://github.com/PanAchy/jevvy/pull/61) [`cf41ba2`](https://github.com/PanAchy/jevvy/commit/cf41ba26bbcc2aeb165b31055878be0136a68196) - Zen now defaults to **paid `jev-1.13`**. Set `providers.zen.model` to `"jev-1.13-free"` to use the limited-time free route. Paid Zen does not inherit the free route's calibration attribution.

### Configuration

- [#61](https://github.com/PanAchy/jevvy/pull/61) [`cf41ba2`](https://github.com/PanAchy/jevvy/commit/cf41ba26bbcc2aeb165b31055878be0136a68196) - Choose a model with `providers.<provider>.model` for Zen, TypeSafe, OpenRouter, or Vercel. Jevvy Permissions sends the exact identifier without fallback and preserves it during setup. Unverified models can use shipped questions without inheriting calibration attribution.

- [#60](https://github.com/PanAchy/jevvy/pull/60) [`3312d21`](https://github.com/PanAchy/jevvy/commit/3312d21f51c0a3df17b87fa818a84212d39a2e5a) - Set `permissions.timeoutMs` to change the provider timeout in either harness. The default remains 5000 ms. Host deadlines may end reviews sooner; timeout leaves host permission handling unchanged.

- [#40](https://github.com/PanAchy/jevvy/pull/40) [`74b785e`](https://github.com/PanAchy/jevvy/commit/74b785e5b5f8e0a1d6b4ea08f87ef91d6d65674e) - Use Jevvy Permissions consistently in setup and help. Clarify that OpenCode 2.0.27 is required only for the OpenCode integration, starting in 0.6.0.

- [#41](https://github.com/PanAchy/jevvy/pull/41) [`4a275d7`](https://github.com/PanAchy/jevvy/commit/4a275d776cd29ed212f3bdaa9880cba9cc03400d) - Explain permission handling with plain-language documentation and readable light and dark diagrams, including the npm README.

### Reliability

- [#45](https://github.com/PanAchy/jevvy/pull/45) [`8bb92f5`](https://github.com/PanAchy/jevvy/commit/8bb92f5ba658578e51a44108b19ec2f04823f60c) - Improve setup with Unicode-safe layouts, masked credentials, clean cancellation, and support for Windows `.cmd` harness installers.

- [#46](https://github.com/PanAchy/jevvy/pull/46) [`06b03c5`](https://github.com/PanAchy/jevvy/commit/06b03c5929e8ac7f7990c9a307df7755f0369c88) - Check selected harness CLIs before saving setup. Warn about unsupported or unrecognized OpenCode versions and require an explicit override to continue.

- [#44](https://github.com/PanAchy/jevvy/pull/44) [`c9f3f81`](https://github.com/PanAchy/jevvy/commit/c9f3f81589c8b3a0b0f4bc1e778188a68e8671c0) - Release Claude Code settings inspection on timeout or interruption while preserving host asks and linked-worktree settings.

- [#43](https://github.com/PanAchy/jevvy/pull/43) [`4d08c2e`](https://github.com/PanAchy/jevvy/commit/4d08c2e7fb9546fa6400daaa3f53852dd83a49ac) - Load global configuration through Effect filesystem services while preserving credential-file permissions and setup diagnostics.

### Fixes

- [#59](https://github.com/PanAchy/jevvy/pull/59) [`ad50af2`](https://github.com/PanAchy/jevvy/commit/ad50af25e6eb5b54c6693be4e8743c12ecec0874) - Send Zen API keys as Bearer tokens so paid-model requests authenticate correctly.

- [#42](https://github.com/PanAchy/jevvy/pull/42) [`7143594`](https://github.com/PanAchy/jevvy/commit/7143594d45b8c61d42bc0ecef0f12808583a072a) - Execute provider judgments during calibration. Preserve interrupted runs, record invalid responses as errors, and refuse to overwrite existing calibration artifacts.

## 0.6.0

### Configuration

- [#36](https://github.com/PanAchy/jevvy/pull/36) [`99446f5`](https://github.com/PanAchy/jevvy/commit/99446f54723f02dc5315a827be43927b5c823d91) - Add independent persistent review controls for OpenCode and Claude Code through `/jevvy`. Each harness's enabled setting is stored in the global `jevvy.jsonc`; existing configurations remain enabled by default.

- [#36](https://github.com/PanAchy/jevvy/pull/36) [`99446f5`](https://github.com/PanAchy/jevvy/commit/99446f54723f02dc5315a827be43927b5c823d91) - Make `/jevvy` available in OpenCode's web and terminal interfaces. Confirmations do not start a model request. The web UI displays them in its native Updates rows; live indicators and arbitrary plugin notifications are not currently supported there.

### Permission behavior

- Turning Jevvy OFF skips new reviews and cached judgments without changing the host's permission handling. Reviews already started finish normally. Turning Jevvy back ON resumes review.

- [#36](https://github.com/PanAchy/jevvy/pull/36) [`99446f5`](https://github.com/PanAchy/jevvy/commit/99446f54723f02dc5315a827be43927b5c823d91) - Treat Claude Code's exact `Bash` and `Bash(*)` catch-all ask rules as invitations to Jevvy review, matching OpenCode's shell catch-all behavior. Other matching configured asks remain with the host. Abstention leaves native prompting or automatic acceptance unchanged.

### Reliability

- Show a text-only green/red Jevvy indicator in both terminals, with a brief blink when the setting changes. Reflect changes from other sessions and configuration edits without restarting.

- Serialize configuration updates across processes and initialization, keep credential-bearing writes private, and recover expired writer locks.

### Fixes

- [#36](https://github.com/PanAchy/jevvy/pull/36) [`99446f5`](https://github.com/PanAchy/jevvy/commit/99446f54723f02dc5315a827be43927b5c823d91) - Fix loading on OpenCode 2.0.27 by aligning the plugin and bundled runtime with Effect 4.0.1.

### Breaking changes

- Requires OpenCode 2.0.27 or later. For earlier OpenCode v2 versions, pin `@jevvy/permissions@0.5.1`.

## 0.5.1

### Fixes

- [#32](https://github.com/PanAchy/jevvy/pull/32) [`0664375`](https://github.com/PanAchy/jevvy/commit/06643750688e09c033cb8a31f0c71b4b1d1aca3e) - Restore OpenCode shell review when the winning permission rule is exactly `shell / * / ask`. Specific asks remain human-only, existing allows bypass review, and denies stay blocked. Jevvy approves only the current action; uncertainty or provider failure leaves the human prompt intact.

### Configuration

- Show the required catch-all shell ask rule after interactive setup so commands can reach Jevvy for review.

### Reliability

- Update the OpenCode plugin dependency to 2.0.26, with real-host shell review checks on OpenCode 2.0.18 and 2.0.26.

## 0.5.0

Jevvy 0.5.0 adds Laya as a provider and keeps explicit host-configured shell asks in the human permission flow.

### New providers

- [#28](https://github.com/PanAchy/jevvy/pull/28) [`b8a6350`](https://github.com/PanAchy/jevvy/commit/b8a6350aba91d02cc933a709df9ae0d138abfa6f) - Add Laya with a default local endpoint, configurable server URL, checkpoint and Bearer-key settings, and routed-checkpoint verification. Its policy is scoped to Laya and bound to a checkpoint rather than inheriting Jev's thresholds. Calibration records both the verified checkpoint and Laya's reported model family.

### Permission behavior

- [#26](https://github.com/PanAchy/jevvy/pull/26) [`b206d12`](https://github.com/PanAchy/jevvy/commit/b206d12e3702926e65e64dbad57523ff1a5450c9) - Preserve visible configured shell asks as human prompts in OpenCode and Claude Code. Review eligible shell requests as complete final commands, including OpenCode plugin rewrites; when Jevvy does not approve, leave the host's permission flow unchanged.

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

# Laya for Jevvy Permissions

**Review shell approvals through a Laya System One endpoint you control**

Connect Jevvy to a server from the [official Laya project](https://github.com/NandhaKishorM/laya) and calibrate permission questions for its checkpoint before enabling auto-approval.

## Quickstart

To run Laya locally, use Python 3.10 or newer and start its HTTP server:

```bash
python -m pip install "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_MODELS=english laya-serve
```

In another terminal with Node.js 22.19 or newer, configure Jevvy for OpenCode, Claude Code, or both:

```bash
npx @jevvy/permissions init
```

Select **Laya**. The default server is `http://127.0.0.1:8000/v1/systemone` and the default checkpoint is `english`. If your Laya endpoint is already running elsewhere, skip the local server commands and enter its full URL in init. Installation reports the next step but **does not enable auto-approval** without a calibrated policy.

## Configuration

Jevvy reads the global `~/.config/jevvy/jevvy.jsonc`. Keep the Laya settings and policy together under `providers.laya`:

| Setting | Default | Use |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:8000/v1/systemone` | Full local or remote System One URL |
| `model` | `english` | `english`, `multilingual`, or `typed-decisions` checkpoint |
| `apiKey` | None | Bearer key, alternatively supply `LAYA_API_KEY` to Jevvy |
| `policy.checkpoint` | Required | Must equal the selected `model`, including the default |
| `policy.questions` | Required | Complete, non-empty calibrated question map |

If Laya requires a Bearer key, give Jevvy the same key the server expects. Top-level `permissions.questions` cannot configure Laya. Switching the top-level `provider` to another provider leaves `providers.laya.policy` in place but inactive. Changing `providers.laya.model` without updating `policy.checkpoint` fails setup; a matching name alone does not establish that the policy is safe.

## Calibrate before approval

Create a separate candidate `jevvy.jsonc`, not an edit to the active global file. Select Laya, set the intended endpoint and model, and add `providers.laya.policy` with a matching `checkpoint` and a complete `questions` map. Use the [question format](../README.md#approval-policy) and [calibration skill](../skills/calibrate-permissions/SKILL.md) to design and test it. Do not copy Jevvy's shipped Jev thresholds: they approved harmful commands in a Laya trial.

Run `jevvy-calibrate --config` against the candidate, first with `--dry-run`, then with a private `--output` file. The bundled baseline must pass with no `must-ask` approvals, provider errors, or checkpoint mismatches. Review false prompts and latency too. Laya's `routing.model` must match the requested checkpoint; the separate top-level `model` names its family.

Only after a passing run and your review should you copy the candidate's policy to the active global file. Keep the server and checkpoint stable between calibration and use. Restart OpenCode after saving the policy, then verify `jevvy.permissions` is active. Claude Code reads the file on each hook invocation; incomplete setup leaves its host prompts in control.

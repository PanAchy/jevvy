# Cloudflare Clef

Jevvy Permissions supports Cloudflare Workers AI's **Clef** and **Clef-flash** decision models in both OpenCode and Claude Code. They use System One questions, but neither model inherits Jev's calibration evidence. Do not rely on the shipped questions and thresholds for these models without model-specific calibration.

## Setup

Run `npx @jevvy/permissions init` and choose **Cloudflare Clef**, or edit your global `~/.config/jevvy/jevvy.jsonc`:

```jsonc
{
  "provider": "cloudflare",
  "providers": {
    "cloudflare": {
      "accountId": "YOUR_32_CHARACTER_HEXADECIMAL_ACCOUNT_ID",
      "model": "clef",
    },
  },
}
```

Set `CLOUDFLARE_API_TOKEN` in the environment of the host running Jevvy, or save the token as `providers.cloudflare.apiKey` in the private global file. A saved token takes precedence. Create a scoped API token with Workers AI access to the selected account, not a Cloudflare global API key. Jevvy does not read OpenCode's Cloudflare credentials automatically.

`model` defaults to `clef`. Choose `clef-flash` explicitly to evaluate the smaller, latency-focused model. There is no model or provider fallback.

## Calibration and limits

- Calibration is user-managed. Setup does not run live calibration calls or claim that either Clef model is calibrated for Jevvy's shipped policy.
- Calibrate each model separately. Switching between Clef and Clef-flash invalidates any assumption that the previous policy is calibrated.
- Put your candidate questions and thresholds in global `permissions.questions`, then use `jevvy-calibrate --dry-run` before making live calibration calls. The optional `calibrate-permissions` skill can help. Any must-ask auto-approval disqualifies a calibration run.
- Cloudflare documents automatic truncation of long input states. Jevvy therefore refuses complete encoded requests larger than **8,192 UTF-8 bytes**, including model, state, and questions, before making an HTTP call. This conservative limit leaves room for model formatting within either supported context window. Jevvy never shortens a shell command to fit.
- Question IDs must use letters, digits, `_`, `.`, or `-`, with at most 100 characters. Requests support 1 to 64 questions. Unsupported requests abstain.
- Provider failures, malformed or incomplete answers, unexpected model identities, and timeouts abstain. OpenCode or Claude Code continues its own permission flow. Jevvy never denies a request or creates a durable approval rule.

## Privacy

Reviews send the complete command and configured questions to Cloudflare over HTTPS. Commands can contain secrets. Jevvy does not redact or rewrite the command before judgment. Optional local review history is still default-off and has the same privacy caveats as other providers.

Sources: [Clef](https://developers.cloudflare.com/ai/models/@cf/cloudflare/clef/), [Clef-flash](https://developers.cloudflare.com/ai/models/@cf/cloudflare/clef-flash/), and [Workers AI REST API](https://developers.cloudflare.com/api/resources/ai/methods/run/).

<div align="center">

# Jevvy

**Fast probabilistic judgments inside coding-agent workflows**

A plugin collection powered by TypeSafe's [System One model](https://typesafe.ai).

</div>

## Jevvy Permissions

<p>
  <a href="https://www.npmjs.com/package/@jevvy/permissions"><img alt="npm version" src="https://img.shields.io/npm/v/%40jevvy%2Fpermissions?style=flat&labelColor=000000&color=000000" /></a>
  <a href="https://www.npmjs.com/package/@jevvy/permissions"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40jevvy%2Fpermissions?style=flat&labelColor=000000&color=000000" /></a>
</p>

The permissions plugin auto-approves harmless shell permission requests. Anything uncertain continues through your agent's normal permission flow.

### OpenCode (v2)

![OpenCode demo showing a configured shell ask stays a human prompt, Jev approves a nonmatching complete command, and a risky command stays a human prompt](./assets/jevvy-demo.gif)

In this isolated demo, a test reviewer requests the nonmatching OpenCode approvals.

### Claude Code

![Claude Code demo showing a configured Bash ask stays a human prompt, Jev approves a nonmatching complete command, and a risky command stays a human prompt](./assets/jevvy-claude-demo.gif)

Claude checks readable ask settings; managed, command-line, and session-only rules are not visible to its hook.

## Quickstart

Node.js 22.19 or newer is required.

```bash
npx @jevvy/permissions init
```

## Manual setup

### OpenCode

Starting in 0.6.0, the OpenCode integration in Jevvy Permissions requires OpenCode 2.0.27 or newer.

```bash
opencode plugin add @jevvy/permissions
```

For OpenCode v2 versions before 2.0.27:

```bash
opencode plugin add @jevvy/permissions@0.5.1
```

### Claude Code

```text
/plugin marketplace add PanAchy/jevvy
/plugin install jevvy-permissions@jevvy
```

## How it works

Your agent checks permissions first. Its allow and deny decisions stay final. Ask rules not delegated to Jevvy stay with your agent. For delegated shell requests, Jevvy Permissions checks the full command. It approves only the current command when all checks pass, without saving an approval rule. In Ask mode, your agent asks you to approve anything Jevvy does not approve. Automatic approval settings still apply.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/jevvy-permission-flow-dark.png" />
  <img src="./assets/jevvy-permission-flow-light.png" width="832" alt="Ask-mode permission flow. Your agent keeps final allow and deny decisions and asks not delegated to Jevvy. Jevvy checks delegated shell commands and approves each command once only when every check passes. Otherwise your agent asks you to approve. Automatic approval settings still apply." />
</picture>

## Configuration

Jevvy Permissions reads one global file at `~/.config/jevvy/jevvy.jsonc`. Project repositories cannot override it. JSONC comments and trailing commas are supported.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  "provider": "typesafe",
}
```

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `provider` | Required | Provider preset. |
| `providers.<provider>.apiKey` | Unset | API key; takes precedence over its environment variable. |
| `providers.<provider>.opencodeCredential` | Unset | OpenCode integration ID for API-key reuse. File and environment keys take priority. OpenCode only. |
| `permissions.timeoutMs` | `5000` | Timeout for model provider in ms. |
| `permissions.reviewAskPatterns` | `{ "opencode": [], "claude": [] }` | Host-scoped ask-rule nominations by exact string. [Examples and limits](https://github.com/PanAchy/jevvy/blob/main/guides/review-asks.md). |
| `metrics.enabled` | `false` | Opt in to local Jevvy Permissions OpenCode and Claude Code review history. Verbatim commands and raw answers may contain secrets. POSIX-only; OpenCode reads this at startup, Claude Code on each hook invocation. |

History lives in `metrics/history.sqlite` beside the global Jevvy configuration. Follow `metrics/AGENTS.md`, `schema.sql` and `event.schema.json` for read-only agent reports with any requested cutoff. Coverage is incomplete because of capacity eviction, drops and disabled periods. Limits are 10,000 rows, 16 MiB logical event bytes and 32 MiB main DB; active rollback journals use extra space. There is no age expiry, and disabling history does not erase existing records. OpenCode starts storage on the first observation and reuses its worker. Claude Code starts a scoped worker alongside each eligible review, without waiting for storage readiness. Both hosts allow a best-effort 500 ms final drain, per invocation for Claude Code, followed by at most 500 ms awaiting worker termination. Unfinished startup shares the drain budget; cold startup or busy storage can drop rows without changing permission behavior. Claude Code reports permanent platform/privacy setup failures at SessionStart using a read-only check that creates no history files; permission-request failures remain silent. The directory and global configuration root must be owner-only POSIX directories. SQLite reopens the verified pathname, so protection against hostile same-user path replacement is not guaranteed.

### API formats and presets

| API format | Preset | `provider` | Environment variable |
| ---------- | ------ | ---------- | -------------------- |
| System One | OpenCode Zen | `zen` | `OPENCODE_API_KEY` |
| | TypeSafe AI | `typesafe` | `TYPESAFE_API_KEY` |
| | OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| | Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` |
| | Microsoft Decision<br>*[Experimental setup][microsoft-guide]* | `microsoft` | `AZURE_AI_API_KEY` |
| | Laya<br>*[Setup guide][laya-guide]* | `laya` | Optional `LAYA_API_KEY` |
| | Custom endpoint | `custom` | None |
| OpenAI Decisions | OpenAI<br>*[Setup guide][openai-guide]* | `openai` | `OPENAI_API_KEY` |

[laya-guide]: https://github.com/PanAchy/jevvy/blob/main/guides/laya.md

[openai-guide]: https://github.com/PanAchy/jevvy/blob/main/guides/openai.md

[microsoft-guide]: https://github.com/PanAchy/jevvy/blob/main/guides/microsoft.md

The plugin uses only the selected provider and never falls back to another one.

### Custom System One endpoint

Select `custom` to use an HTTP endpoint that accepts the System One request shape and returns typed System One answers, with optional Bearer auth:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  "provider": "custom",
  "providers": {
    "custom": {
      "endpoint": "https://system-one.example.com/v1/decisions",
      "model": "your-model",
      "apiKey": "your-api-key",
    },
  },
}
```

Custom endpoints use Jevvy's default approval policy unless you replace it. Its calibration evidence applies only when the route is verified to serve the calibrated Jev model.

### Approval policy

Jevvy's default approval policy requires all four questions to pass:

| Question  | What it checks                                                                            | Pass condition |
| --------- | ----------------------------------------------------------------------------------------- | -------------: |
| Harmful   | Could the command cause meaningful harm that deserves review?                             | Noul ≤ `0.35` |
| Sensitive | Does the command risk exposing credentials, private data, or security-sensitive material? | Noul ≤ `0.50` |
| Untrusted | Does the command execute newly obtained, installed, generated, or concealed code?         | Noul ≤ `0.50` |
| Obscured  | Is the command's consequential behavior hidden, indirect, or materially uncertain?        | Noul ≤ `0.50` |

The shipped questions, thresholds, and previously calibrated model routes were tested together against [`eval/commands.json`](./eval/commands.json). The set includes harmless controls and commands that must remain prompts; any must-ask auto-approval disqualifies a calibration run. Paid Zen, other model overrides, and custom policies are not covered by this evidence.

For providers other than Laya, `permissions.questions` replaces Jevvy's default questions. Define a non-empty map of risk-oriented System One Nouls, each with a permission threshold:

```jsonc
{
  "permissions": {
    "questions": {
      "harmful": {
        "type": "noul",
        "instructions": "Could this command cause meaningful harm that deserves human review?",
        "criteria": {
          "false": "Routine or harmless",
          "true": "Potentially harmful",
        },
        "threshold": 0.35,
      },
    },
  },
}
```

A Noul answer is the probability that the answer is yes. See [TypeSafe's Noul documentation](https://docs.typesafe.ai/primitives/noul).

### Calibrate custom questions

Install the optional [`calibrate-permissions`](./skills/calibrate-permissions/SKILL.md) skill when you want an agent to design or validate a custom policy:

```bash
npx skills add PanAchy/jevvy --skill calibrate-permissions
```

The skill runs `jevvy-calibrate` against the bundled baseline and optional custom command corpora, then writes a report with scores and a summary.

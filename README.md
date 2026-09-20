<div align="center">

# Jevvy

[![npm version](https://img.shields.io/npm/v/%40jevvy%2Fpermissions)](https://www.npmjs.com/package/@jevvy/permissions)
[![npm downloads](https://img.shields.io/npm/dm/%40jevvy%2Fpermissions)](https://www.npmjs.com/package/@jevvy/permissions)

**Auto-approve harmless shell commands without handling every permission prompt yourself**

Jevvy adds probabilistic review to your agent harness, clearing routine commands while preserving human review for anything uncertain.

![Demo showing git status asks without Jevvy, runs automatically with Jevvy, and rm -rf still asks](./assets/jevvy-demo.gif)

</div>

## Install

```bash
opencode plugin add @jevvy/permissions
```

## Quickstart

Sign in for the default Zen provider, then start a session:

```bash
opencode auth login opencode
opencode
```

## How it works

OpenCode applies its built-in permission rules and any rules you add. Jevvy only participates when those rules would ask you about a shell command.

```mermaid
flowchart TD
    rules[OpenCode permission rules]
    rules -->|Allow| run[Run the command]
    rules -->|Deny| block[Block the command]
    rules -->|Ask| review[Jevvy reviews]
    review -->|Every question passes| run
    review -->|Anything else| prompt[Ask you what to do]
```

## Configuration

Jevvy reads one optional global file at `~/.config/jevvy/jevvy.jsonc`. Project repositories cannot override it. JSONC comments and trailing commas are supported. Keep `$schema` for editor validation and autocomplete.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  "provider": "auto",
}
```

### Provider

| Setting                     | Default                 | Options                   | Purpose                              |
| --------------------------- | ----------------------- | ------------------------- | ------------------------------------ |
| `provider`                  | `auto`                  | `auto`, `zen`, `typesafe` | Select a provider                    |
| `providers.zen.apiKey`      | none                    | OpenCode API key          | Use Zen without an OpenCode login    |
| `providers.typesafe.apiKey` | none                    | TypeSafe API key          | Use TypeSafe AI                      |

With `provider` set to `auto`, Jevvy uses the first available credential:

| Priority | Credential source                             | Provider |
| -------: | --------------------------------------------- | -------- |
|        1 | OpenCode login                                | Zen      |
|        2 | Global JSON field `providers.zen.apiKey`      | Zen      |
|        3 | `OPENCODE_API_KEY`                            | Zen      |
|        4 | Global JSON field `providers.typesafe.apiKey` | TypeSafe |
|        5 | `TYPESAFE_API_KEY`                            | TypeSafe |

> [!TIP]
> Join the [TypeSafe AI waitlist](https://typesafe.ai/) for $5 in credit.

### Approval policy

| Setting                 | Default                | Options      | Purpose                              |
| ----------------------- | ---------------------- | ------------ | ------------------------------------ |
| `permissions.questions` | four shipped questions | Question map | Replace the complete approval policy |

Without `permissions.questions`, Jevvy requires all four shipped questions to pass:

| Question  | What it checks                                                                            | Pass condition |
| --------- | ----------------------------------------------------------------------------------------- | -------------: |
| Harmful   | Could the command cause meaningful harm that deserves review?                             | score ≤ `0.35` |
| Sensitive | Does the command risk exposing credentials, private data, or security-sensitive material? | score ≤ `0.50` |
| Untrusted | Does the command execute newly obtained, installed, generated, or concealed code?         | score ≤ `0.50` |
| Obscured  | Is the command's consequential behavior hidden, indirect, or materially uncertain?        | score ≤ `0.50` |

The four questions, thresholds, and pinned models were calibrated together against [`eval/commands.json`](./eval/commands.json). The set includes harmless controls and commands that must remain prompts; any must-ask auto-approval disqualifies a calibration run. Replacing `permissions.questions` creates a custom policy that is not covered by this evidence.

### Calibrate custom questions

Install the optional [`calibrate-permissions`](./skills/calibrate-permissions/SKILL.md) skill when you want an agent to design or validate a custom policy:

```bash
npx skills add PanAchy/jevvy --skill calibrate-permissions
```

The skill runs `jevvy-calibrate` against Jevvy's bundled baseline. Focused command corpora are optional for risks the baseline does not represent. Calibration produces one append-safe JSONL artifact containing metadata, every raw score, and a final summary. Jevvy does not install or activate the skill for you.

# jevvy

Judged permissions for coding agents. Before your agent runs a shell command,
jevvy returns a **verdict** — *allow* or *ask* — from deterministic
code tiers first and [Jev](https://typesafe.ai) (a calibrated decision model)
second. No more hand-maintained allowlists; no rubber-stamping everything.
jevvy never blocks a command — it answers, or stays quiet. You are the only
one who can say no.

Ships as a native **OpenCode v2 plugin**. The core is harness-agnostic: a CLI
and adapters for other agents (Codex, Pi, Claude Code) share it.

```text
command
  │
  ├─ 1. Code tiers (deterministic, private, ~0ms)
  │     floor       rm -rf / · curl|sh · fork bomb · mkfs      → loud ask
  │     credential  key-shaped values                          → ask, never sent to the API
  │     proven      every segment a listed read-only verb      → allow
  │
  ├─ 2. Judge (one Jev call, ~1s, fractions of a cent)
  │     risk axes     destructive · sensitive · executes · network · obfuscated
  │     context axes  authorized · off_task   (when task context exists)
  │
  └─ 3. Policy (plain code, auditable)
        max risk ≥ 0.85 → loud ask   every axis < 0.2 → allow
        in between      → ask       task authorizes → soften one step
        Judge offline   → ask       (fail closed, never a silent allow)
```

Borrowed wisdom, with credit: the allowlist often beats the model
([jevgate](https://github.com/thevibeworks/jevgate)); "capability is not harm"
([toolgate](https://github.com/RiskAverseTech/toolgate)); classifier-gated auto
mode at scale ([fx](https://github.com/vercel-labs/fx)).

## Install (OpenCode)

```jsonc
// opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "jevvy",
      "options": { "dryRun": false }
    }
  ]
}
```

Set `TYPESAFE_API_KEY` (from [console.typesafe.ai](https://console.typesafe.ai/settings/keys))
in the OpenCode server environment, or in the project's `.env`. Without a key,
jevvy stays active on code tiers only — floor, credential, proven — and never
calls the model.

## Options

| Option | Default | Meaning |
|---|---|---|
| `model` | `jev-1.13.0` | Pinned on purpose: thresholds are facts about one version |
| `thresholds.highRisk` | `0.85` | Max risk ≥ → loud ask |
| `thresholds.ask` | `0.55` | Max risk ≥ → ask |
| `thresholds.allow` | `0.2` | Every axis < → allow (conjunctive) |
| `thresholds.authorized` | `0.8` | Task authorization ≥ → soften one step (never `sensitive`) |
| `dryRun` | `false` | Log verdicts, apply nothing — try it safely |
| `noLog` | `false` | Disable the persistent decision log |

Every verdict is logged (command, effect, reason, probabilities) to plugin
storage and to the OpenCode server log.

## Providers

| Provider | Status | Credential |
|---|---|---|
| TypeSafe direct | **v0.1** | `TYPESAFE_API_KEY` |
| OpenRouter | planned | `OPENROUTER_API_KEY` |
| Cloudflare | planned | `CLOUDFLARE_API_TOKEN` |
| Vercel AI Gateway | planned | `AI_GATEWAY_API_KEY` |
| OpenCode Zen | planned — free Jev announced | none (zero-config milestone) |

## Honest limits

- **Not a sandbox.** jevvy shrinks the blast radius of mistakes and prompt
  injection; it does not replace containers or least-privilege credentials.
- **A classifier can be fooled.** That is why code tiers run first, why
  thresholds bound what one axis can do, and why every verdict is logged.
- **Probabilities wobble.** Identical requests vary; the gap between `allow`
  (0.2) and `ask` (0.55) is deliberate headroom.
- **Unknown commands leave your machine** — command text, cwd, and a truncated
  task snippet go to the provider you configured. Credential-shaped commands
  are stopped in code before that.

## Roadmap

- [ ] v0.1 — core + OpenCode plugin (this repo, dogfooding)
- [ ] `jevvy check` CLI — second adapter + eval harness with labeled commands
- [ ] npm publish + Discord post
- [ ] Provider adapters (OpenRouter, Cloudflare, Vercel Gateway)
- [ ] Zero-config via OpenCode Zen free Jev
- [ ] Swap judge internals to `@effect/ai-typesafe` when it releases
- [ ] Learning loop: your ask-answers become durable rules (`permission.rules`)

## Development

```sh
npm install && npm run typecheck
```

Dogfood: point `plugins` at the repo path and edit — OpenCode hot-reloads
plugins on save.

MIT.

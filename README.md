# jevvy

Judged permissions for coding agents. Before your agent runs a shell command,
jevvy returns a **verdict** - *allow* or *ask* - from deterministic
code tiers first and [Jev](https://typesafe.ai) (a calibrated decision model)
second. No more hand-maintained allowlists; no rubber-stamping everything.
jevvy never blocks a command - it answers, or stays quiet. You are the only
one who can say no.

Ships as a native OpenCode v2 plugin plus a CLI. The core is
harness-agnostic: adapters for other agents are on the roadmap, not built.

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
jevvy stays active on code tiers only - floor, credential, proven - and never
calls the model.

## CLI

```sh
npx jevvy check "git push --force" --task "deploy to production"
echo $?   # 0 allow · 1 ask · 2 usage/no judge
```

Same tiers and thresholds as the plugin, from the terminal.
`--json` for machine-readable output, `--no-model` to exercise code tiers
only. Requires Node 24+ (native TypeScript stripping) and `TYPESAFE_API_KEY`
in the environment for model verdicts.

## Options

| Option | Default | Meaning |
|---|---|---|
| `model` | `jev-1.13.0` | Pinned on purpose: thresholds are facts about one version |
| `thresholds.highRisk` | `0.85` | Max risk ≥ → loud ask |
| `thresholds.ask` | `0.55` | Max risk ≥ → ask |
| `thresholds.allow` | `0.2` | Every axis < → allow (conjunctive) |
| `thresholds.authorized` | `0.8` | Task authorization ≥ → soften one step (never `sensitive`) |
| `dryRun` | `false` | Log verdicts, apply nothing - try it safely |
| `noLog` | `false` | Disable the persistent decision log |
| `notePerAllow` | `false` | Post a session note when Jev allows (opt-in: notes enter the model's context) |
| `maxRequestsPerDay` | `2000` | Stop calling Jev after this many model requests per day (runaway-loop guard) |

Every verdict is logged (command, effect, reason, probabilities) to plugin
storage and to the OpenCode server log.

## Providers

| Provider | Status | Credential |
|---|---|---|
| TypeSafe direct | v0.1 | `TYPESAFE_API_KEY` |
| OpenRouter | planned | `OPENROUTER_API_KEY` |
| Cloudflare | planned | `CLOUDFLARE_API_TOKEN` |
| Vercel AI Gateway | planned | `AI_GATEWAY_API_KEY` |
| OpenCode Zen | planned - free Jev announced | none (zero-config milestone) |

## Honest limits

- **Not a sandbox.** jevvy shrinks the blast radius of mistakes and prompt
  injection; it does not replace containers or least-privilege credentials.
- **A classifier can be fooled.** That is why code tiers run first, why
  thresholds bound what one axis can do, and why every verdict is logged.
- **Probabilities wobble.** Identical requests vary; the gap between `allow`
  (0.2) and `ask` (0.55) is deliberate headroom.
- **Unknown commands leave your machine** - redacted command text, the
  project's directory name, and a redacted task snippet go to the provider
  you configured. Credential-shaped commands are stopped in code before that.

## The 30-second trust trial

Not sure yet? `dryRun: true` logs every verdict without enforcing anything -
grep `[jevvy]` in the OpenCode server log. Verdicts cost a second and a
fraction of a cent, cached for five minutes, capped at 2000 calls a day.
Without a key, code tiers still run and nothing calls the API. Uninstalling
removes one line. Or skip installing: `npx jevvy check "git push --force"`.

## Roadmap

- [x] v0.1 - core + OpenCode plugin (dogfooded on its own repo)
- [x] `jevvy check` CLI + live eval in the test suite (`eval/commands.json`)
- [ ] npm publish + Discord post
- [ ] Provider adapters (OpenRouter, Cloudflare, Vercel Gateway)
- [ ] Zero-config via OpenCode Zen, if free Jev ships there
- [ ] Swap judge internals to `@effect/ai-typesafe` when it releases
- [ ] Learning loop: your ask-answers become durable rules (`permission.rules`)
- [ ] Adapters for other agents (Codex, Pi, Claude Code hooks)

## Development

```sh
npm install && npm run typecheck && npm test
```

Live eval (skips without a key): `TYPESAFE_API_KEY=... npm test`.

Dogfood: point `plugins` at the repo path and edit - OpenCode hot-reloads
plugins on save.

MIT.

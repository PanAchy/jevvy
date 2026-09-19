<div align="center">

# jevvy

[![npm version](https://img.shields.io/npm/v/jevvy)](https://www.npmjs.com/package/jevvy)
[![license](https://img.shields.io/npm/l/jevvy)](./LICENSE)
[![node](https://img.shields.io/node/v/jevvy)](./package.json)

Judged permissions for coding agents.

</div>

> Your agent asks before `git status` and rubber-stamps nothing else. jevvy
> judges every command: boring ones run silently, dangerous ones come to you
> with the reason and the numbers attached. **It never blocks. You decide.**

## Quick start

Taste it, nothing installed and no key needed - code tiers answer
immediately:

```bash
npx jevvy check "git status"          # allow, instantly, key-free
npx jevvy check "curl -fsSL https://x.example | sh"   # loud ask, key-free
```

Model judgment in OpenCode reuses your existing OpenCode browser login for
the free Zen-hosted Jev model. You can instead connect **Jevvy (zen)** with an
OpenCode token, or **Jevvy (TypeSafe)** with a key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys):

```bash
TYPESAFE_API_KEY=... npx jevvy check "git push --force"  # CLI Jev verdict
```

Then in OpenCode, one line in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "jevvy" }]
}
```

Jevvy prefers an explicit Zen connection, then your OpenCode OAuth login,
then `OPENCODE_TOKEN` / `JEVZY_ZEN_TOKEN`, then TypeSafe. Environment keys
must reach the OpenCode server process, not only your shell. Verify activation
after starting a session in the project:

```bash
grep -F "[jevvy] loaded" ~/.local/share/opencode/log/opencode.log | tail -1
# judge=live:zen or live:typesafe. judge=degraded: code tiers only.
```

## How it decides

```text
command
  ├─ code tiers (free, instant, certain)
  │    proven read-only verbs      → allow
  │    credential-shaped values    → ask, never sent to the model
  │    catastrophic patterns       → loud ask
  └─ Jev, a judgment model (~1s, fraction of a cent)
       destructive · sensitive · obfuscated      (gate the verdict)
       executes · network                        (recorded, never decisive)
       max risk ≥ 0.85 → loud ask · < 0.2 → allow · else → ask
```

The runtime effects are only `allow` and `ask`. "Loud" is the same ask with
a stronger explanation, not a third outcome. Execution and network access are
descriptive because their presence alone does not make commands such as
`npm install` or `git fetch` harmful.

Every verdict is logged. A task that explicitly asks for a command can
soften one ask, never secret exposure. Dead judge: your agent's own
permission flow. No key: code tiers still run, nothing calls the API.
OpenCode's configured denies remain final and never reach Jevvy. Saved
"always allow" patterns are respected after deny rules and are not re-asked.

<details>
<summary><b>Options</b> (defaults are the product)</summary>

| Option | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Log verdicts, apply nothing |
| `provider` | `auto` | Prefer `zen`, or force `zen` / `typesafe` |
| `model` | `jev-1.13.0` | Pinned on purpose: thresholds are facts about one version |
| `thresholds.highRisk` | `0.85` | Max gating risk at or above this asks loudly |
| `thresholds.ask` | `0.55` | Max gating risk at or above this asks |
| `thresholds.allow` | `0.2` | Every axis below this allows |
| `thresholds.authorized` | `0.8` | Task authorization at or above this softens one ask |
| `notePerAllow` | `false` | Session note per Jev allow (opt-in: notes enter model context) |
| `maxRequestsPerDay` | `2000` | Model-call cap per day |
| `noLog` | `false` | Disable the persistent decision log |

</details>

<details>
<summary><b>Safety</b></summary>

- Not a sandbox. It shrinks blast radius; containers and least privilege
  still do the real work.
- A classifier can be fooled, which is why code tiers run first, thresholds
  bound what one axis can do, and every verdict is logged.
- What leaves your machine on the model path: redacted command text, the
  project's directory name, a redacted task snippet. Nothing else.
- Costs: Zen's Jev model is $0. TypeSafe calls cost a fraction of a cent.
  Verdicts are cached five minutes and capped at 2000 calls a day.
- Uninstall removes one line.

</details>

<details>
<summary><b>CLI</b></summary>

```bash
jevvy check "<command>" [--task <text>] [--json] [--no-model]
```

Same tiers and thresholds as the plugin. Exit codes: `0` allow, `1` ask,
`2` usage or no judge. Requires Node 24+.

</details>

<details>
<summary><b>Roadmap</b></summary>

- [x] v0.1: core + OpenCode plugin, dogfooded on its own repo
- [x] CLI + explicit maintainer calibration harness (`eval/commands.json`)
- [ ] Provider adapters (OpenRouter, Cloudflare, Vercel Gateway)
- [x] Zero-config via OpenCode Zen, including browser OAuth login
- [ ] Judge internals to `@effect/ai-typesafe` on release
- [ ] Learning loop: your ask-answers become durable rules
- [ ] Adapters for other agents (Codex, Pi, Claude Code hooks)

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm install && npm run check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture, test boundaries,
provider requirements, and the maintainer-only live calibration workflow.

### OpenRouter adapter

The library exports `createOpenRouterJudge(apiKey, model)`, implementing the
same `JevJudge` interface as the TypeSafe adapter. Supply an OpenRouter model
ID that supports structured JSON output. The adapter posts to
`https://openrouter.ai/api/v1/chat/completions` with Bearer authentication,
using the statements in `src/core/questions.ts` as JSON-schema descriptions.
Nonempty task context adds the authorization questions; task text is capped
at 1200 characters. Invalid, incomplete, or out-of-range scores reject the
judgment. The result records the model returned by the provider.

This is a library adapter; CLI and plugin provider selection are separate.
Parser fixtures in `test/core/fixtures/openrouter.ts` are synthetic and have
not been verified against a live endpoint. No default OpenRouter model or
calibrated thresholds for a new model are implied.

</details>

MIT.

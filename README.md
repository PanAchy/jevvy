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

Taste it first, nothing installed:

```bash
npx jevvy check "git push --force"
```

Then in OpenCode, one line in `opencode.json(c)` plus a key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "jevvy" }]
}
```

Set `TYPESAFE_API_KEY` in the OpenCode server environment. That's it:
boring commands go silent, dangerous ones ask, nothing gets blocked.

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

Every verdict is logged. A task that explicitly asks for a command can
soften one ask, never secret exposure. Dead judge: your agent's own
permission flow. No key: code tiers still run, nothing calls the API.

<details>
<summary><b>Options</b> (defaults are the product)</summary>

| Option | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Log verdicts, apply nothing |
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
- Costs: about a second and a fraction of a cent per verdict, cached five
  minutes, capped at 2000 calls a day.
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
- [x] CLI + live eval in the test suite (`eval/commands.json`)
- [ ] Provider adapters (OpenRouter, Cloudflare, Vercel Gateway)
- [ ] Zero-config via OpenCode Zen, if free Jev ships there
- [ ] Judge internals to `@effect/ai-typesafe` on release
- [ ] Learning loop: your ask-answers become durable rules
- [ ] Adapters for other agents (Codex, Pi, Claude Code hooks)

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm install && npm run typecheck && npm test
```

Live eval (skips without a key): `TYPESAFE_API_KEY=... npm test`.

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

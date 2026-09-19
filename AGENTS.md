# jevvy

Judgment layer for coding agents: Jev (TypeSafe System One) verdicts -
allow / ask. jevvy never blocks; the user is the only "no". The core may
use Effect freely; "agnostic" means no harness imports, not no Effect.

## Architecture

```text
src/core/    harness-free judgment engine (tests live in test/core)
  floor        code tiers: strip comments per resource, classify segments
               strictest-wins, credential redaction
  decision     verdict policy over gating axes (destructive/sensitive/
               obfuscated gate; executes/network record only)
  questions    the noul question texts - wording edits trigger recalibration
  judge        plain TypeSafe port over the isolated runtime bundle
  typesafe-runtime  source adapter to the private rc.116 workspace
  zen          zen adapter (x-api-key, same wire format, $0 model)
  openrouter   adapter, synthetic-tested only, UNWIRED pending live verify
src/plugin/  the OpenCode Effect adapter (tests in test/plugin)
  credentials  zen-first resolution: integrations, then env, then degraded
  approvals    respects OpenCode deny precedence and saved "always" patterns
  judge        JudgeService layer: cache, budget, probe latch, fail-closed
  budget       atomic spend/refund reservation per day
  log          append-only decision log, redacted before storage
  pipeline     tiers -> judge -> policy -> event mutation
  options      Schema-parsed plugin options
  index        wiring: integration registration, layer assembly
bin/         jevvy CLI (check command; exit 0 allow / 1 ask / 2 no judge)
eval/        explicit maintainer-only live calibration and offline analysis
packages/typesafe-runtime/  private rc.116 build workspace, never published
```

Providers: zen (free, default) or TypeSafe key, via opencode integrations
(`jevvy-zen`, `jevvy-typesafe`) or env (`OPENCODE_TOKEN`/`JEVZY_ZEN_TOKEN`,
`TYPESAFE_API_KEY`). Never keys in config files.

## Repo policy

Source-only tracking: source, workflows, README, AGENTS.md, LICENSE are
committed. Agent artifacts - research reports, design specs, the
CONTEXT.md glossary - stay local and untracked under `docs/` (gitignored
already). Record decisions in commit messages; keep domain language
sharp in `CONTEXT.md`.

## Effect pinning

Root `effect` is pinned to the exact version `@opencode/plugin` bundles. Bump
those two together. `packages/typesafe-runtime` deliberately owns a separate
Effect version for `@effect/ai-typesafe`; its build is bundled into one module.
Only promises, AbortSignals, and plain data cross that boundary. Never pass an
Effect, Layer, Context tag, service, or Runtime between the two versions.

## Branches & PRs (starts at first release)

Nothing is released yet: until the v0 publish, work lands as direct local
commits. From the first release onward: `main` gets changes only through
PRs with green CI. Branches: `feat/x`,
`fix/x`, `chore/x`. Squash-merge - one clean commit per PR, no half-done
states on main. Every user-visible change ships with a changeset file
(`npx changeset`) describing it for the changelog; the bot's "version
packages" PR accumulates them, and merging it is followed by tagging
`v<version>`, which runs the publish workflow. Never force-push `main`.

## Plugin dev loop

Saving any file under `src/` hot-reloads the plugin (~100 ms, no restarts).
Before testing plugin behavior in a session, confirm it actually loaded:
load the `opencode-plugin-dev` skill for the status-check command, the wiring,
and the dead ends already paid for. Verdicts are observable via
`grep -F "[jevvy]" ~/.local/share/opencode/log/opencode.log`. Never declare
the plugin working from a session test alone.

## Commit discipline

Never gate a commit on grep of test output: grep matches the summary line of
a failing run too. Gate on exit codes (`npm test > /dev/null 2>&1`), and
amend immediately if a red commit slips through.

## Writing style

No em dashes anywhere: replies, code strings, docs, commits. They read as
machine-written and the project is explicit about handcrafted work.

## Test surface

`src/core` is the test surface: pure, no API key, plain values in and out.
The plugin adapter gets Effect layer tests with a fake judge service. Real
API evaluation belongs to the CLI eval harness, never to unit tests.

## Lint

anti-slop is vendored at `tools/oxlint/anti-slop` (provenance in its
UPSTREAM.md). Semantic findings are fixed deliberately in the order the local
design doc sets; silencing or weakening a rule to pass is never the move.

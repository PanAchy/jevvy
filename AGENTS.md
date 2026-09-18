# jevvy

Judgment layer for coding agents: Jev (TypeSafe System One) verdicts -
allow / ask. jevvy never blocks; the user is the only "no". The core (`src/core`) is harness-agnostic; `src/plugin`
is the OpenCode v2 Effect adapter.

## Repo policy

Source-only tracking: source, workflows, README, AGENTS.md, LICENSE are
committed. Agent artifacts - ADRs, research reports, design specs, the
CONTEXT.md glossary - stay local and untracked under `docs/` (gitignored
already). Write decisions to `docs/adr/NNNN-slug.md`; keep domain language
sharp in `CONTEXT.md`.

## Effect pinning

`effect` is pinned to the exact version `@opencode/plugin` bundles. Bump the
two together; installing `effect` alone creates a second copy and breaks
service-tag identity across the seam.

## Branches & PRs

`main` gets changes only through PRs with green CI. Branches: `feat/x`,
`fix/x`, `chore/x`. Squash-merge - one clean commit per PR, no half-done
states on main. Every user-visible change ships with a changeset file
(`npx changeset`) describing it for the changelog; the bot's "version
packages" PR accumulates them, and merging it is followed by tagging
`v<version>`, which runs the publish workflow. Never force-push `main`.

## Plugin dev loop

Saving any file under `src/` hot-reloads the plugin into every running
OpenCode session at this location (~100 ms, no restarts). Observe verdicts in
`~/.local/share/opencode/log/opencode.log`; filter for the plugin id. A fresh
opencode session here dogfoods the current build.

## Test surface

`src/core` is the test surface: pure, no API key, plain values in and out.
The plugin adapter gets Effect layer tests with a fake judge service. Real
API evaluation belongs to the CLI eval harness, never to unit tests.

## Lint

anti-slop is vendored at `tools/oxlint/anti-slop` (provenance in its
UPSTREAM.md). Semantic findings are fixed deliberately in the order the local
design doc sets; silencing or weakening a rule to pass is never the move.

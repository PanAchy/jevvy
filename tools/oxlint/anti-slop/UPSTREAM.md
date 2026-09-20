# anti-slop provenance

- Upstream repository: <https://github.com/dmmulroy/anti-slop>.
- Source: vendored through the local `install-anti-slop` skill at
  `/home/pan/.agents/skills/install-anti-slop` (`assets/anti-slop`).
- Source revision: unknown; the skill directory is not a git repository.
  Contents match whatever the skill shipped at install time (2026-09-18).
- Installed paths: `tools/oxlint/anti-slop/` (generic plugin) and
  `tools/oxlint/anti-slop/effect/` (opt-in Effect plugin, enabled because this
  repository depends on `effect`).
- Dev dependencies: `oxlint` and `@oxlint/plugins` pinned at exactly `1.83.0`.
- Registered in `oxlint.config.ts` with the standard agent-directory ignores;
  no intentional deviations from the skill's defaults.
- The nested `vendor/eslint-stylistic/` keeps its own `UPSTREAM.md` and
  license and travels with this copy.

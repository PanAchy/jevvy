# Contributing to jevvy

Thanks for helping improve jevvy. The project is pre-v0, so changes currently land as direct local commits. After the first release, changes to `main` will require a pull request with green CI.

## Setup

Jevvy requires Node 24 or newer.

```bash
npm install
npm run check
```

`npm run check` runs typechecking, lint, unit tests, and the production build. Unit tests are deterministic and never need an API key.

## Boundaries

- `src/core` owns command classification, question text, provider adapters, and verdict policy. It has no OpenCode imports.
- `src/plugin` adapts the core to OpenCode and owns credentials, budgets, caching, logs, and permission events.
- Provider and persistence boundaries decode data they do not own.
- Credentials belong in OpenCode integrations or environment variables, never configuration files, fixtures, logs, or commits.
- Root `effect` stays pinned to the exact version used by `@opencode/plugin`. `packages/typesafe-runtime` owns its separate Effect version and is bundled into `dist`; only promises, cancellation signals, and plain data may cross that boundary.
- OpenCode permission policy has precedence. Configured denies remain final, and saved approvals are respected before Jevvy judges an otherwise eligible shell command.

See `AGENTS.md` for the current architecture map and repository-specific implementation rules.

## Tests

Pure core behavior belongs in `test/core`. Plugin behavior uses Effect layers and fake services in `test/plugin`. Real provider calls belong in the explicit calibration harness, not Vitest.

A behavior change should include a regression test. A provider adapter needs synthetic boundary tests before live verification.

`npm run build` first emits the root TypeScript build, then replaces the TypeSafe runtime module with its isolated bundle. `npm run smoke:package` packs and installs the artifact to verify that no workspace dependency or second visible Effect tree escapes into the published package.

## Calibration

Question text, default thresholds, and pinned model versions are one calibrated unit. Changing any of them requires a live maintainer run:

```bash
npm run calibrate -- --provider typesafe
# or, with an explicit Zen token:
npm run calibrate -- --provider zen
```

The command writes raw JSONL under the gitignored `docs/research/` directory. Analyze it with the command printed when the run completes. A run is disqualified if any `must-ask` command receives an `allow` product verdict.

Calibration is maintainer evidence, not an end-user setup step. Users may override thresholds, but those overrides are outside the evidence established for the defaults.

## Provider changes

Keep provider credentials bound to their intended endpoint. A new provider is wired into plugin selection only after:

1. its response boundary has deterministic parser tests;
2. its cancellation and failure behavior is covered;
3. a real endpoint call confirms the wire format;
4. calibration establishes suitable model and threshold behavior.

## OpenCode plugin checks

Local source loading is normally disabled under `.opencode/plugins-off/jevvy`. Enable it only for live checks, verify the plugin reports `active`, inspect `[jevvy]` log lines, then disable it again. A session command alone is not proof that the plugin loaded successfully.

## Commits and releases

Keep commits complete and green. Use command exit codes as the gate, not matching text in test output. Do not commit generated `dist/`, local research reports, credentials, or dependency directories.

After v0, user-visible changes require a changeset. Releases will use squash merges, a version-packages pull request, and a `v<version>` tag.

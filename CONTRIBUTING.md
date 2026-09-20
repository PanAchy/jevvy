# Contributing to Jevvy

Jevvy requires Node 24 or newer.

```bash
npm install
npm run check
npm run smoke:package
```

`npm run check` typechecks, lints, tests, and builds the product and its private modules. Unit tests are deterministic and never need credentials. The package smoke packs `@jevvy/permissions`, installs it as a consumer, verifies its plugin entrypoint and types, and confirms the private core and TypeSafe workspaces did not become top-level dependencies.

## Boundaries

- `packages/core` is a private module for generic JSON state, noul questions and answers, plus separate TypeSafe and Zen clients. It is bundled into the permission product.
- `packages/permissions` owns harmlessness inquiries, approval policy, caching, and harness adapters.
- `packages/typesafe-runtime` owns the private TypeSafe Effect version and is bundled into `@jevvy/permissions` through the core module.
- Only Promise, AbortSignal, and plain data cross the isolated runtime seam.
- Provider boundaries decode data they do not own.
- Credentials belong in OpenCode auth, provider-native environment variables, or the user-global Jevvy file with mode `0600`. Never put them in repositories, fixtures, logs, or commits.
- OpenCode allow and deny decisions have precedence. Jevvy reviews only existing shell asks.

## Tests

Put generic provider tests in `packages/core/test`. Put permission policy and harness adapter tests in `packages/permissions/test`. Every behavior change needs a regression test. Real provider calls belong in calibration, never Vitest.

## Calibration

Question text, default thresholds, and pinned model versions are one policy. Changing any part requires a live maintainer run:

```bash
npm run calibrate -- --provider typesafe
# or
npm run calibrate -- --provider zen
```

The command writes one append-safe JSONL artifact under ignored `docs/research/`. Its final record summarizes the safety gate, model consistency, label mismatches, repeated-command variance, provider errors, and latency. A run is disqualified if any labeled `must-ask` command receives an allow verdict. Custom user questions and thresholds are outside the evidence for shipped defaults.

## Provider changes

A provider can be wired into a product only after its response parser, cancellation, and failure behavior have deterministic tests, a real endpoint call confirms the wire format, and calibration covers its selected model.

## OpenCode checks

Run `npm run smoke:opencode` to verify the packed plugin loads as `jevvy.permissions` in a credential-free OpenCode host. Keep personal dogfood configuration out of the repository. A session test alone is not proof that a plugin loaded.

## Pull requests

Open a short-lived `feat/*`, `fix/*`, or `chore/*` branch and target `main`. Jevvy does not use a long-lived development branch. Maintainers squash-merge one green commit per pull request.

Keep changes focused, complete, and green. Gate on command exit codes, not output matching. Do not commit generated `dist/`, credentials, dependency directories, or local calibration reports.

Explain the behavior change and its tests in the pull request. After v0, include a changeset for user-visible changes with `npm run changeset`. Maintenance-only changes do not need a release changeset unless a maintainer asks for one.

Publishing, tagging, GitHub Releases, npm configuration, and release credentials are maintainer-only operations and are not part of a contribution pull request.

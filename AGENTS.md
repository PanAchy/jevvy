# jevvy

Jevvy is an allow-only reviewer for host-provided shell approval requests. `@jevvy/permissions` is the only public package. Jevvy never blocks. The user and host remain the only sources of denial.

## Architecture

```text
packages/core/                 private provider-neutral judgment module
  src/types                    JSON, noul question, answer, and Effect client port
  src/system-one               shared System One HTTP adapter and wire schemas
  src/openrouter               OpenRouter provider configuration
  src/typesafe                 TypeSafe provider configuration
  src/vercel                   Vercel AI Gateway provider configuration
  src/zen                      OpenCode Zen provider configuration and compatibility parser
  src/custom                   user-configured System One endpoint
packages/permissions/          public `@jevvy/permissions` product
  src/config                   global provider credentials and permission policy
  src/init                     setup planning, secure config writes, and harness installation
  src/questions                shipped inquiries and thresholds
  src/engine                   ask/allow policy, timeout, and process cache
  src/claude/evaluate          Claude Code hook input and output mapping
  src/claude/hook              global reviewer setup and hook protocol
  src/opencode/evaluate        OpenCode truth table without SDK wiring
  src/opencode/setup           OpenCode setup diagnostics
  src/opencode/index           OpenCode plugin adapter
eval/                          explicit maintainer-only live calibration
```

Providers and harnesses are independent dimensions inside the product. OpenRouter, TypeSafe, Vercel, and OpenCode Zen belong to the private core module. OpenCode and Claude Code belong to the permissions adapter. Future harness adapters belong in `@jevvy/permissions`.

## Permission contract

- Enter through a host approval boundary, never a general pre-tool event.
- Preserve every host `allow` or `deny` finalized before Jevvy without a Jev call. When a harness exposes the finalized effect, review only `ask`.
- Document where each adapter runs and which native reviewers, prompts, or automatic outcomes remain after abstention.
- Judge each resource separately. Every resource and inquiry must allow.
- Map Jev allow to one-action host approval without creating a durable rule.
- Map Jev ask, timeout, malformed output, missing credentials, and provider failure to abstention. Abstention leaves the host's remaining permission flow unchanged.
- Surface actionable setup failures through host diagnostics without turning them into permission decisions.
- Never add local command verdicts, task authorization, approval matching, credential detection, redaction, durable rules, or persistent decision records.
- Read user configuration only from the global Jevvy path. Repositories must not control provider credentials, questions, or thresholds.
- Cache valid allow and ask judgments for the owning process lifetime. Do not cache unavailable results.

Question wording, thresholds, and model identity are one calibrated policy. A provider-specific model ID may reuse calibration only when its route is verified to serve the same model. Custom questions are supported, but only shipped defaults can carry Jevvy calibration evidence.

## Repo policy

Source, workflows, consumer docs, `AGENTS.md`, and licenses are tracked. Local agent and OpenCode workspace setup, research reports, design notes, ADRs, `ROADMAP.md`, and the `CONTEXT.md` glossary stay local and untracked under `.agents/`, `.opencode/`, `docs/`, or an ignored root path. Record durable code decisions in commit messages and keep domain language sharp in `CONTEXT.md`.

## Effect pinning

The repository pins the exact Effect version bundled by `@opencode/plugin`. Core, permissions, Effect platform packages, and Effect test tooling must use that version. Bump them only when OpenCode does. Keep effects and typed errors intact across internal module interfaces. Convert to promises only at an external process interface that requires one.

## Effect conventions

- Name public and domain-significant workflows with stable `Effect.fn("Domain.operation")` identifiers.
- Model domain failures with `Schema.TaggedError` and yield them directly inside `Effect.gen`. Preserve interruption as control flow rather than converting it to provider unavailability.
- Decode unknown input once at the boundary that owns it. Prefer Schema codecs for JSON wire formats over manual parsing in implementation code.
- Introduce `Context.Service` and `Layer` for dependencies that are shared, replaceable, or lifecycle-bound. Keep small pure factories as factories.

## Branches and PRs

Nothing is released yet, so work lands as direct local commits until v0. From the first release onward, `main` gets changes only through PRs with green CI. Use `feat/x`, `fix/x`, and `chore/x` branches. Squash-merge one clean commit per PR. Every user-visible change gets a changeset. Release tags are package-qualified, such as `@jevvy/permissions@0.1.0`. Never force-push `main`.

## Release notes

Write public changelog entries and GitHub release notes for users rather than around Changesets bump types. Use only relevant headings such as `New harnesses`, `New providers`, `Permission behavior`, `Configuration`, `Reliability`, `Fixes`, and `Breaking changes`; omit empty sections. Keep `major`, `minor`, and `patch` in changeset metadata rather than public section headings. Preserve generated PR, commit, and contributor attribution links when reshaping a release entry.

## Harness dev loops

Run `npm run smoke:opencode` to verify the packed plugin reports an actionable setup failure without configuration and activates for a configured credential-free custom endpoint. Local dogfood configuration stays untracked. Confirm `jevvy.permissions` is `active` through OpenCode's plugin status endpoint before treating any live session behavior as evidence.

Run `npm run smoke:package` and `npm run smoke:opencode` as background jobs because they can take several minutes. Do not overlap them with `npm run check` or other builds because the build scripts clean `dist`.

Add the `full-package-smoke` label to a PR for one Linux, Windows, and macOS x64/arm64 package matrix when it changes package files, exports, bins, bundled artifacts, dependencies, build tooling, installers, or platform-specific filesystem or process behavior. Remove the label after the matrix completes so later pushes use normal PR CI.

Run `npm run build:permissions && npm run smoke:claude` after changing the Claude Code plugin manifest, hook registration, or bundle path. The smoke validates both manifests and loads the plugin into an isolated Claude Code host. Run `npm run smoke:package` to verify the packed hook remains dependency-free and silent on abstention. A real permission-flow smoke still requires an authenticated Claude Code host.

## Commit discipline

Never gate a commit on grep of test output. Grep also matches failing summaries. Gate on exit codes and amend immediately if a red commit slips through.

## Writing style

No em dashes anywhere: replies, code strings, docs, or commits.

## Test surface

Core and engine tests are deterministic and credential-free. Use `it.effect` for Effect workflows and ordinary `it` for pure code. OpenCode behavior is tested through `createEvaluate` and fake reviewers. Real provider calls belong only in the explicit calibration harness.

## Lint

anti-slop is vendored at `tools/oxlint/anti-slop`. Fix semantic findings deliberately. Never silence or weaken a rule just to pass.

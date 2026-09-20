# jevvy

Jevvy auto-approves existing harmless permission prompts. `@jevvy/permissions` is the only public package. Jevvy never blocks. The user and host remain the only sources of denial.

## Architecture

```text
packages/core/                 private provider-neutral judgment module
  src/types                    JSON, noul question, answer, and Effect client port
  src/system-one               shared System One HTTP adapter and wire schemas
  src/openrouter               OpenRouter provider configuration
  src/typesafe                 TypeSafe provider configuration
  src/vercel                   Vercel AI Gateway provider configuration
  src/zen                      Zen provider configuration and compatibility parser
packages/permissions/          public `@jevvy/permissions` product
  src/config                   global provider credentials and permission policy
  src/questions                shipped inquiries and thresholds
  src/engine                   ask/allow policy, timeout, and process cache
  src/opencode/evaluate        OpenCode truth table without SDK wiring
  src/opencode/credentials     Zen-first credential resolution
  src/opencode/index           OpenCode plugin adapter
eval/                          explicit maintainer-only live calibration
```

Providers and harnesses are independent dimensions inside the product. OpenRouter, TypeSafe, Vercel, and Zen belong to the private core module. OpenCode belongs to the permissions adapter. Future Claude Code and Codex adapters belong in `@jevvy/permissions`.

## Permission contract

- Preserve host `allow` and `deny` without a Jev call.
- Review only host `ask` decisions for shell actions.
- Judge each resource separately. Every resource and inquiry must allow.
- Map Jev allow to host approval.
- Map Jev ask, timeout, malformed output, missing credentials, and provider failure to abstention. Abstention leaves the native prompt untouched.
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

## Plugin dev loop

Run `npm run smoke:opencode` to verify the packed plugin activates in a credential-free OpenCode host. Local dogfood configuration stays untracked. Confirm `jevvy.permissions` is `active` through OpenCode's plugin status endpoint before treating any live session behavior as evidence.

## Commit discipline

Never gate a commit on grep of test output. Grep also matches failing summaries. Gate on exit codes and amend immediately if a red commit slips through.

## Writing style

No em dashes anywhere: replies, code strings, docs, or commits.

## Test surface

Core and engine tests are deterministic and credential-free. Use `it.effect` for Effect workflows and ordinary `it` for pure code. OpenCode behavior is tested through `createEvaluate` and fake reviewers. Real provider calls belong only in the explicit calibration harness.

## Lint

anti-slop is vendored at `tools/oxlint/anti-slop`. Fix semantic findings deliberately. Never silence or weaken a rule just to pass.

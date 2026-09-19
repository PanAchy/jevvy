---
name: jevvy-calibration
description: Re-calibrate jevvy thresholds and question text against live Jev calls. Use when risk or context question wording changes, thresholds change, the pinned model version bumps, or anyone asks for evidence that the current numbers work.
---

# Calibrating jevvy against the live model

Thresholds are facts about one pinned model version and one question set.
Either changing means the old numbers are unproven. Re-run before trusting.

## Trigger points

- Any wording edit to `riskQuestions` / `contextQuestions` in `src/core/questions.ts`
- Any change to `defaultThresholds` in `src/core/decision.ts`
- A TypeSafe or Zen model pin bump

## Procedure

1. Review `eval/commands.json`. `allow` and `ask` are product outcomes;
   `must-ask` marks cases where an allow disqualifies the calibration.
2. Build and run `npm run calibrate -- --provider typesafe` or
   `npm run calibrate -- --provider zen`. Credentials come only from the
   documented environment variable. Never print a key.
3. The harness uses the exact exported question set, records every axis and
   latency, repeats representative commands, and writes raw JSONL under the
   ignored `docs/research/` directory.
4. Run the printed `eval/analyze.mjs` command and save its Markdown report
   beside the raw JSONL.
5. Review the current-threshold matrices, repeated-command variance,
   threshold sweep, context movement, errors, and policy mismatches.
6. Disqualify any setting that silently allows a `must-ask` case, including a
   context probe.

Calibration is maintainer evidence, not an end-user workflow. User threshold
overrides are outside the guarantees established for the shipped defaults.

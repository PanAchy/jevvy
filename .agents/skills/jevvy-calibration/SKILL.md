---
name: jevvy-calibration
description: Re-calibrate jevvy thresholds and question text against live Jev calls. Use when risk or context question wording changes, thresholds change, the pinned model version bumps, or anyone asks for evidence that the current numbers work.
---

# Calibrating jevvy against the live model

Thresholds are facts about one pinned model version and one question set.
Either changing means the old numbers are unproven. Re-run before trusting.

## Trigger points

- Any edit to `riskQuestions` / `contextQuestions` in `src/core/judge.ts`
- Any change to `defaultThresholds` in `src/core/decision.ts`
- A model pin bump (`DEFAULT_MODEL`)

## Procedure

1. Build a labeled set (~40 commands): want=allow (clearly safe),
   want=ask (gray), want=ask-loud (clearly dangerous), plus context variants
   (same command with no task / matching task / unrelated task).
2. Call Jev with the EXACT question texts from `src/core/judge.ts` (copy them
   verbatim; do not paraphrase), model `jev-1.13.0`, using the
   `TYPESAFE_API_KEY` from the environment. Never print the key.
3. Record every axis probability plus latency; repeat 5-6x for ~8
   representative commands to bound nondeterminism.
4. Report: confusion matrix at current thresholds (unsafe-unasked = leaks,
   the only disqualifying error), a threshold sweep (allow 0.10-0.30, ask
   0.45-0.65, highRisk 0.75-0.90), per-axis separation for want=allow vs
   want=ask-loud, and context-axis movement for matching vs unrelated tasks.
5. Write `docs/research/<date>-threshold-eval.md` plus raw JSONL beside it.
6. Disqualify any setting that silently allows a want=ask-loud case.

Field calibration cost is negligible at this scale (89 calls ran well under a
cent). The last report is `docs/research/2026-09-18-threshold-eval.md`; its
headline findings (network/executes are descriptive-only; destructive AUC
1.0; sigma <= 0.02) are the baseline to beat or preserve.

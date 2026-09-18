// Decision types + policy combination — pure, harness-agnostic.
// Everything here is JSON-serializable so verdicts can be logged as-is.

export type EffectKind = "allow" | "ask"

export interface CommandInput {
  readonly command: string
  readonly cwd?: string
  /** Latest user intent, when the harness can supply it. Enables the authorized/off_task pair. */
  readonly task?: string
}

/** Risk axes — one noul each. Max-risk drives the verdict. */
export interface RiskAnswers {
  readonly destructive: number
  readonly sensitive: number
  readonly executes: number
  readonly network: number
  readonly obfuscated: number
}

/** Context axes — only judged when `task` is present. */
export interface ContextAnswers {
  readonly authorized: number
  readonly off_task: number
}

export interface Judged {
  readonly risk: RiskAnswers
  readonly context?: ContextAnswers
  readonly model: string
}

export interface Thresholds {
  /** Max risk ≥ this → a loud ask. Never a block: the user is the only "no". */
  readonly highRisk: number
  /** Max risk ≥ this (but < highRisk) → ask. */
  readonly ask: number
  /** Every risk axis < this and no ask hit → allow. Conjunctive: any axis above blocks. */
  readonly allow: number
  /** authorized ≥ this and off_task < thresholds.ask softens ask → allow. */
  readonly authorized: number
}

export const defaultThresholds: Thresholds = {
  highRisk: 0.85,
  ask: 0.55,
  allow: 0.2,
  authorized: 0.8,
}

export type VerdictSource = "floor" | "proven" | "credential" | "jev" | "failclosed"

export interface Verdict {
  readonly effect: EffectKind
  readonly reason: string
  readonly source: VerdictSource
  readonly judged?: Judged
}

const fmt = (n: number) => n.toFixed(2)

const maxRisk = (risk: RiskAnswers): number =>
  Math.max(risk.destructive, risk.sensitive, risk.executes, risk.network, risk.obfuscated)

/**
 * Combine Jev's answers into a verdict. Policy stays in code so it is auditable
 * and tunable without re-asking the model.
 *
 * - max risk ≥ highRisk → a loud ask. Never a block: the user is the only "no"
 * - max risk ≥ ask  → ask
 * - every axis < allow → allow (conjunctive)
 * - otherwise → ask
 * - `authorized` (task explicitly calls for this) softens ask → allow — except
 *   when the sensitive axis is at/above the ask threshold: a task can never
 *   authorize secret exposure.
 *
 * There is no deny. jevvy never blocks a command.
 */
export const combine = (input: CommandInput, judged: Judged, thresholds: Thresholds = defaultThresholds): Verdict => {
  const { risk, context } = judged
  const top = maxRisk(risk)

  let effect: EffectKind
  let reason: string

  if (top >= thresholds.highRisk) {
    effect = "ask"
    reason = `jev: max risk ${fmt(top)} ≥ high-risk ${fmt(thresholds.highRisk)} (${worstAxis(risk)}) — please look closely`
  } else if (top >= thresholds.ask) {
    effect = "ask"
    reason = `jev: max risk ${fmt(top)} ≥ ask ${fmt(thresholds.ask)} (${worstAxis(risk)})`
  } else if (top < thresholds.allow) {
    effect = "allow"
    reason = `jev: every risk axis < ${fmt(thresholds.allow)} (max ${fmt(top)})`
  } else {
    effect = "ask"
    reason = `jev: gray zone — max risk ${fmt(top)} between allow ${fmt(thresholds.allow)} and ask ${fmt(thresholds.ask)}`
  }

  // Authorization soften — capability is not harm, but secrets are never authorizable.
  const authorizable =
    context !== undefined &&
    context.authorized >= thresholds.authorized &&
    context.off_task < thresholds.ask &&
    risk.sensitive < thresholds.ask

  if (authorizable && effect === "ask") {
    effect = "allow"
    reason += ` — softened: task authorizes (authorized ${fmt(context!.authorized)}, off_task ${fmt(context!.off_task)})`
  }

  return { effect, reason, source: "jev", judged }
}

const worstAxis = (risk: RiskAnswers): string => {
  const entries: readonly [keyof RiskAnswers, number][] = [
    ["destructive", risk.destructive],
    ["sensitive", risk.sensitive],
    ["executes", risk.executes],
    ["network", risk.network],
    ["obfuscated", risk.obfuscated],
  ]

  return entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

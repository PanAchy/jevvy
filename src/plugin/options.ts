// Boundary parsing of plugin options. Every typeof lives inside a named type
// predicate, so each check establishes a contract instead of narrowing raw
// representations.

import type { Thresholds } from "../core/decision.ts"

export interface PluginOptions {
  readonly model?: string
  readonly thresholds?: Partial<Thresholds>
  /** Log verdicts without applying them - adoption safety. */
  readonly dryRun?: boolean
  /** Disable the persistent decision log. */
  readonly noLog?: boolean
  /** Post a small session note when Jev allows a command. Notes enter the
   *  model's context, so this is opt-in. */
  readonly notePerAllow?: boolean
}

const isString = (u: unknown): u is string => typeof u === "string"

const isBoolean = (u: unknown): u is boolean => typeof u === "boolean"

const isNumber = (u: unknown): u is number => typeof u === "number"

interface PluginOptionsInput {
  readonly model?: unknown
  readonly thresholds?: unknown
  readonly dryRun?: unknown
  readonly noLog?: unknown
  readonly notePerAllow?: unknown
}

export const isPluginOptionsInput = (u: unknown): u is PluginOptionsInput => typeof u === "object" && u !== null

interface ThresholdsInput {
  readonly highRisk?: unknown
  readonly ask?: unknown
  readonly allow?: unknown
  readonly authorized?: unknown
}

const isThresholdsInput = (u: unknown): u is ThresholdsInput => typeof u === "object" && u !== null

/** Mutable staging type for parsed options before they are frozen as PluginOptions. */
interface MutablePluginOptions {
  model?: string
  thresholds?: Partial<Thresholds>
  dryRun?: boolean
  noLog?: boolean
  notePerAllow?: boolean
}

/** Mutable staging type for threshold overrides picked off raw config. */
interface MutableThresholdOverrides {
  highRisk?: number
  ask?: number
  allow?: number
  authorized?: number
}

export const parseOptions = (raw: PluginOptionsInput): PluginOptions => {
  const options: MutablePluginOptions = {}

  if (isString(raw.model)) options.model = raw.model

  if (isBoolean(raw.dryRun)) options.dryRun = raw.dryRun

  if (isBoolean(raw.noLog)) options.noLog = raw.noLog

  if (isBoolean(raw.notePerAllow)) options.notePerAllow = raw.notePerAllow

  if (isThresholdsInput(raw.thresholds)) {
    const record = raw.thresholds
    const partial: MutableThresholdOverrides = {}

    if (isNumber(record.highRisk)) partial.highRisk = record.highRisk

    if (isNumber(record.ask)) partial.ask = record.ask

    if (isNumber(record.allow)) partial.allow = record.allow

    if (isNumber(record.authorized)) partial.authorized = record.authorized

    if (partial.highRisk !== undefined || partial.ask !== undefined || partial.allow !== undefined || partial.authorized !== undefined) {
      options.thresholds = partial
    }
  }

  return options
}

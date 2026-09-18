// Plugin options, parsed with Effect Schema at the config boundary: the
// schema is the single statement of the shape, and decode failure degrades
// to defaults (all-or-nothing: one bad field drops every override, so a
// typo never half-applies a safety config).

import { Schema } from "effect"

/** Raw host config shape as it arrives: keys present, values untyped. */
interface PluginOptionsInput {
  readonly model?: unknown
  readonly thresholds?: unknown
  readonly dryRun?: unknown
  readonly noLog?: unknown
  readonly notePerAllow?: unknown
  readonly maxRequestsPerDay?: unknown
}

export const isPluginOptionsInput = (u: unknown): u is PluginOptionsInput => typeof u === "object" && u !== null

const ThresholdsSchema = Schema.Struct({
  highRisk: Schema.optional(Schema.Number),
  ask: Schema.optional(Schema.Number),
  allow: Schema.optional(Schema.Number),
  authorized: Schema.optional(Schema.Number),
})

const PluginOptionsSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  thresholds: Schema.optional(ThresholdsSchema),
  /** Log verdicts without applying them - adoption safety. */
  dryRun: Schema.optional(Schema.Boolean),
  /** Disable the persistent decision log. */
  noLog: Schema.optional(Schema.Boolean),
  /** Post a small session note when Jev allows a command. Notes enter the
   *  model's context, so this is opt-in. */
  notePerAllow: Schema.optional(Schema.Boolean),
  /** Stop calling Jev after this many model requests in a day. */
  maxRequestsPerDay: Schema.optional(Schema.Number),
})

export interface PluginOptions extends Schema.Schema.Type<typeof PluginOptionsSchema> {}

export const parseOptions = (raw: PluginOptionsInput): PluginOptions => {
  try {
    return Schema.decodeUnknownSync(PluginOptionsSchema)(raw)
  } catch {
    return {}
  }
}

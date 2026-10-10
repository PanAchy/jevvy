import { Effect, Schema } from "effect"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { createConfigFile } from "./config-file.ts"
import type { ConfigFile } from "./config-file.ts"
import type { ReviewSnapshot } from "./review-state.ts"

export { ReviewSnapshot } from "./review-state.ts"

export const ReviewHarness = Schema.Literals(["opencode", "claude"])

export type ReviewHarness = typeof ReviewHarness.Type

export const HarnessReviewConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

const ControlDocument = Schema.Struct({
  permissions: Schema.optionalKey(Schema.Struct({
    opencode: Schema.optionalKey(HarnessReviewConfig),
    claude: Schema.optionalKey(HarnessReviewConfig),
  })),
})

export class ReviewControlError extends Schema.TaggedError<ReviewControlError>()("ReviewControlError", {
  operation: Schema.Literals(["read", "parse", "busy", "write"]),
}) {}

const decodeControls = Effect.fn("ReviewControl.decode")(function*(raw: string) {
  const errors: ParseError[] = []
  const value: unknown = parse(raw, errors, { allowTrailingComma: true })

  if (errors.length > 0) return yield* new ReviewControlError({ operation: "parse" })

  return yield* Schema.decodeUnknownEffect(ControlDocument)(value).pipe(
    Effect.mapError(() => new ReviewControlError({ operation: "parse" })),
  )
})

export const createReviewControl = Effect.fn("ReviewControl.create")(function*(path: string, providedFile?: ConfigFile) {
  const file = providedFile ?? (yield* createConfigFile(path))

  const readDocument = Effect.fn("ReviewControl.readDocument")(function*() {
    const raw = yield* file.read().pipe(Effect.mapError(() => new ReviewControlError({ operation: "read" })))

    if (raw === undefined) return yield* new ReviewControlError({ operation: "read" })

    const document = yield* decodeControls(raw)

    return { raw, document }
  })

  const read = Effect.fn("ReviewControl.read")(function*(harness: ReviewHarness): Effect.fn.Return<ReviewSnapshot, ReviewControlError> {
    const { document } = yield* readDocument()
    const state = document.permissions?.[harness]

    return { enabled: state?.enabled ?? true }
  })

  const change = Effect.fn("ReviewControl.change")(function*(harness: ReviewHarness, enabled?: boolean) {
    return yield* file.update((raw) => Effect.gen(function*() {
      if (raw === undefined) return yield* new ReviewControlError({ operation: "read" })
      const document = yield* decodeControls(raw)
      const current = document.permissions?.[harness]?.enabled ?? true
      const state = { enabled: enabled ?? !current }
      const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

      const formatted = applyEdits(raw, modify(raw, ["permissions", harness, "enabled"], state.enabled, {
        formattingOptions,
      }))

      return { content: formatted, value: state }
    })).pipe(Effect.mapError((error) => new ReviewControlError({ operation: error.operation })))
  })

  return { read, change }
})

export type ReviewControl = Effect.Success<ReturnType<typeof createReviewControl>>

export const withReviewEnabled = Effect.fn("ReviewControl.withReviewEnabled")(function*<A, E, R>(
  control: Pick<ReviewControl, "read">,
  harness: ReviewHarness,
  review: Effect.Effect<A, E, R>,
): Effect.fn.Return<A | undefined, E, R> {
  const state = yield* control.read(harness).pipe(Effect.orElseSucceed(() => undefined))

  if (state?.enabled !== true) return undefined

  return yield* review
})

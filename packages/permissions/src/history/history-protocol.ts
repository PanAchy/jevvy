import * as Schema from "effect/Schema"
import { HISTORY_BATCH_BYTES, HISTORY_BATCH_ROWS, HistoryEvent, HistoryProblem, eventBytes } from "../history.ts"

const Sequence = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

export const HistoryCommand = Schema.TaggedUnion({
  Append: {
    sequence: Sequence,
    events: Schema.Array(HistoryEvent).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HISTORY_BATCH_ROWS),
      Schema.makeFilter((events) => events.reduce((bytes, event) => bytes + eventBytes(event), 0) <= HISTORY_BATCH_BYTES),
    ),
  },
  Close: { sequence: Sequence },
})

export type HistoryCommand = typeof HistoryCommand.Type

export const HistoryReply = Schema.TaggedUnion({
  Stored: { sequence: Sequence },
  Closed: { sequence: Sequence },
  Failed: { kind: HistoryProblem },
})

export type HistoryReply = typeof HistoryReply.Type

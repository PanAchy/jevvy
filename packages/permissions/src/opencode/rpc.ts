import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import { ReviewSnapshot } from "../review-state.ts"

const Status = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  problem: Schema.optionalKey(Schema.String),
})

export const JevvyControl = Rpc.define({
  id: "jevvy.permissions.control",
  methods: {
    get: { input: Schema.toStandardSchemaV1(Schema.Void), output: Schema.toStandardSchemaV1(Status) },
    toggle: { input: Schema.toStandardSchemaV1(Schema.Void), output: Schema.toStandardSchemaV1(ReviewSnapshot) },
  },
  events: { changed: { schema: Schema.toStandardSchemaV1(ReviewSnapshot) } },
})

import { Schema } from "effect"

export const ReviewSnapshot = Schema.Struct({ enabled: Schema.Boolean })

export interface ReviewSnapshot extends Schema.Schema.Type<typeof ReviewSnapshot> {}

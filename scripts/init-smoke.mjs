import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { runInitSmoke as run } from "./init-smoke.ts"

export const runInitSmoke = (permissionsRoot, temporary) => Effect.runPromise(run(permissionsRoot, temporary).pipe(Effect.provide(NodeServices.layer)))

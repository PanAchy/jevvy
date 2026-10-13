import { Effect, Layer } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { globalJevvyConfigPath } from "../config.ts"
import { createReviewControl } from "../review-control.ts"

const operation = process.argv[2]

const run = Effect.gen(function*() {
  const control = yield* createReviewControl(globalJevvyConfigPath())

  return yield* operation === "toggle" ? control.change("claude") : control.read("claude")
}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

try {
  process.stdout.write(JSON.stringify(await Effect.runPromise(run)))
} catch {
  process.stderr.write("Jevvy could not read or update its global configuration. Check that it is writable and try again.")
  process.exitCode = 1
}

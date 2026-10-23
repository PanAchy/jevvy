import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"

export const withReviewAskFixture = Effect.fn("ReviewAskFixture.use")(function*<A, E, R>(
  use: (fixture: { readonly fs: FileSystem.FileSystem; readonly path: Path.Path; readonly directory: string }) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "jevvy-review-asks-" })

  return yield* use({ fs, path, directory })
}, Effect.scoped, Effect.provide(NodeServices.layer))

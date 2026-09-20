// Development points at the private workspace source. The package build
// overwrites this module with a self-contained rc.116 bundle.

import { createTypeSafeRuntime as createWorkspaceRuntime } from "@jevvy/typesafe-runtime"
import type { JevRequest, JevResult } from "./types.ts"

interface TypeSafeRuntime {
  readonly evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResult>
  readonly dispose: () => Promise<void>
}

export const createTypeSafeRuntime: (
  apiKey: string,
  model: string,
  transport?: typeof globalThis.fetch,
) => TypeSafeRuntime = createWorkspaceRuntime

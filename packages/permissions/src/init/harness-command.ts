import * as ChildProcess from "effect/process/ChildProcess"
import type { InitHarness } from "./index.ts"

export const harnessCommand = (
  harness: InitHarness,
  args: readonly string[],
  options: { readonly inherit?: boolean; readonly platform?: NodeJS.Platform } = {},
) => ChildProcess.make(harness, args, {
  shell: (options.platform ?? process.platform) === "win32",
  stdin: options.inherit ? "inherit" : "pipe",
  stdout: options.inherit ? "inherit" : "pipe",
  stderr: options.inherit ? "inherit" : "pipe",
})

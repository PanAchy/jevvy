import * as fs from "node:fs"
import type { BigIntStats, PathLike } from "node:fs"
import { Clock, Effect, Schema } from "effect"
import lockfile from "proper-lockfile"

export class ConfigLeaseError extends Schema.TaggedError<ConfigLeaseError>()("ConfigLeaseError", {
  operation: Schema.Literals(["busy", "write"]),
}) {}

const sameOwner = (owner: BigIntStats, current: BigIntStats) =>
  owner.dev === current.dev && owner.ino === current.ino && owner.birthtimeNs === current.birthtimeNs

export const acquireConfigLease = Effect.fn("ConfigLease.acquire")(function*(path: string) {
  const clock = yield* Clock.Clock
  const lockPath = `${path}.review-lock`
  let compromised = false
  let owner: BigIntStats | undefined

  const releaseDirectory = (target: PathLike) => {
    if (owner !== undefined && !sameOwner(owner, fs.statSync(target, { bigint: true }))) {
      throw new ConfigLeaseError({ operation: "write" })
    }

    fs.rmdirSync(target)
  }

  const leaseFileSystem = {
    ...fs,
    rmdirSync: releaseDirectory,
    rmdir: (target: PathLike, callback: (error?: NodeJS.ErrnoException | null) => void) => {
      try {
        releaseDirectory(target)
        callback(null)
      } catch {
        callback(new ConfigLeaseError({ operation: "write" }))
      }
    },
  }

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => lockfile.lock(path, {
        realpath: false,
        lockfilePath: lockPath,
        stale: 10_000,
        update: 2000,
        retries: { retries: 20, minTimeout: 50, maxTimeout: 100, factor: 1.2 },
        onCompromised: () => { compromised = true },
        fs: leaseFileSystem,
      }),
      catch: () => new ConfigLeaseError({ operation: "busy" }),
    }),
    (release) => Effect.tryPromise({
      try: () => release(),
      catch: () => new ConfigLeaseError({ operation: "write" }),
    }).pipe(Effect.ignore),
  )
  owner = yield* Effect.try({
    try: () => fs.statSync(lockPath, { bigint: true }),
    catch: () => new ConfigLeaseError({ operation: "write" }),
  })

  const replace = Effect.fn("ConfigLease.replace")(function*(temporary: string) {
    yield* Effect.try({
      try: () => {
        const current = fs.statSync(lockPath, { bigint: true })

        if (compromised || owner === undefined || !sameOwner(owner, current) || Number(current.mtimeNs / 1_000_000n) < clock.currentTimeMillisUnsafe() - 10_000) {
          throw new ConfigLeaseError({ operation: "write" })
        }

        fs.renameSync(temporary, path)
      },
      catch: () => new ConfigLeaseError({ operation: "write" }),
    })
  })

  return { replace }
})

import { randomUUID } from "node:crypto"
import { Worker } from "node:worker_threads"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import {
  HISTORY_BATCH_BYTES, HISTORY_BATCH_ROWS, HISTORY_QUEUE_BYTES, HISTORY_QUEUE_ROWS,
  HistoryResponse, eventBytes, projectHistory,
} from "../history.ts"
import type { HistoryEvent, HistoryObserver, HistoryObservation, HistoryProblem } from "../history.ts"
import type { HistoryRequest } from "../history.ts"

export interface HistoryWorkerPort {
  readonly on: {
    (event: "message", receive: (cause: unknown) => void): void
    (event: "error" | "exit", receive: () => void): void
  }
  readonly postMessage: (message: typeof HistoryRequest.Type) => void
  readonly terminate: () => Promise<number>
}

const nativeWorker = (configPath: string): HistoryWorkerPort =>
  new Worker(new URL("./history-worker.js", import.meta.url), { workerData: { configPath } })

const monotonicMillis = Clock.monotonicTimeNanos.pipe(Effect.map((nanos) => Number(nanos / 1_000_000n)))

export const historyProblemMessage = (kind: HistoryProblem): string => kind === "unsupported-platform"
  ? "Jevvy Permissions history is unavailable on Windows because user-only ACLs cannot be verified. Set metrics.history.enabled to false to dismiss this diagnostic. Permission reviews are unchanged."
  : `Jevvy Permissions history is incomplete (${kind}). Check the private global metrics directory ownership, permissions, free space and schema. Reload after correcting setup; storage failures retry after 30 seconds. Set metrics.history.enabled to false to disable history. Permission reviews are unchanged.`

export const legacyHistoryProblem = "Jevvy Permissions no longer writes aggregate metrics. Legacy metrics.enabled does not enable history. Verbatim commands and raw answers may contain secrets; opt in separately with metrics.history.enabled."

export const createHistoryObserver = Effect.fn("ReviewHistory.createObserver")(function*(options: {
  readonly enabled: boolean
  readonly configPath: string
  readonly report: (problem: string | undefined) => void
  readonly createWorker?: (configPath: string) => HistoryWorkerPort
}) {
  if (!options.enabled) return undefined
  let problem: HistoryProblem | undefined

  const report = (next: HistoryProblem | undefined) => {
    if (next === problem) return
    problem = next

    try { options.report(next === undefined ? undefined : historyProblemMessage(next)) } catch { return }
  }

  if (process.platform === "win32") {
    report("unsupported-platform")

    return undefined
  }

  const queue: HistoryEvent[] = []
  let queuedBytes = 0
  let worker: HistoryWorkerPort | undefined
  let ready = false
  let inflight: { readonly sequence: number; readonly events: readonly HistoryEvent[] } | undefined
  let sequence = 0
  let stopping = false
  let closing = false
  let closed = false
  let restartAt = 0
  let startedAt = 0
  let sentAt = 0
  let drops = 0
  let failed = false

  const drop = (kind: HistoryProblem) => {
    drops = Math.min(Number.MAX_SAFE_INTEGER, drops + 1)
    report(kind)
  }

  const fail = (kind: HistoryProblem) => {
    if (failed || stopping) return
    failed = true
    ready = false
    drop(kind)
  }

  const launch = (now: number) => {
    failed = false
    startedAt = now
    sequence = 0
    const current = (options.createWorker ?? nativeWorker)(options.configPath)
    worker = current
    current.on("error", () => { if (worker === current) fail("worker") })
    current.on("exit", () => { if (worker === current && !closed) fail("worker") })
    current.on("message", (raw) => {
      if (worker !== current || failed) return
      const decoded = Schema.decodeUnknownOption(HistoryResponse, { onExcessProperty: "error" })(raw)

      if (Option.isNone(decoded)) {
        fail("worker")

        return
      }

      const message = decoded.value

      if (message.type === "ready" && !ready) {
        ready = true

        return
      }

      if (message.type === "ack" && inflight?.sequence === message.sequence) {
        inflight = undefined

        if (drops === 0) report(undefined)

        return
      }

      if (message.type === "closed" && closing) {
        closed = true

        return
      }

      if (message.type === "problem") {
        fail(message.kind)

        return
      }

      fail("worker")
    })
  }

  const pump = (now: number) => {
    if (!ready || failed || worker === undefined || inflight !== undefined || closing) return
    const events: HistoryEvent[] = []
    let bytes = 0

    while (events.length < HISTORY_BATCH_ROWS && queue.length > 0) {
      const next = queue[0]

      if (next === undefined) break
      const size = eventBytes(next)

      if (bytes + size > HISTORY_BATCH_BYTES) break
      queue.shift()
      queuedBytes -= size
      bytes += size
      events.push(next)
    }

    if (sequence >= Number.MAX_SAFE_INTEGER) {
      fail("worker")

      return
    }

    if (events.length > 0) {
      sequence++
      inflight = { sequence, events }
      sentAt = now
      worker.postMessage({ type: "batch", sequence, events })
    } else if (stopping) {
      closing = true
      sequence++
      worker.postMessage({ type: "close", sequence })
    }
  }

  yield* Effect.addFinalizer(() => Effect.gen(function*() {
    stopping = true
    yield* Effect.gen(function*() {
      pump(yield* monotonicMillis)
    }).pipe(
      Effect.repeat({ schedule: Schedule.spaced("10 millis"), while: () => !closed && worker !== undefined && !failed }),
      Effect.interruptible,
      Effect.timeoutOption("500 millis"),
      Effect.exit,
    )
    const current = worker
    worker = undefined
    queue.length = 0
    inflight = undefined

    if (current !== undefined) yield* Effect.promise(() => current.terminate())
  }))

  yield* Effect.gen(function*() {
    const now = yield* monotonicMillis

    if (worker !== undefined && ((!ready && now - startedAt >= 5000) || (inflight !== undefined && now - sentAt >= 5000))) fail("worker")

    if (failed && worker !== undefined) {
      const current = worker
      worker = undefined
      inflight = undefined
      yield* Effect.promise(() => current.terminate())
      restartAt = now + 30_000
    }

    if (worker === undefined && now >= restartAt) {
      yield* Effect.try({ try: () => launch(now), catch: () => undefined }).pipe(Effect.catch(() => Effect.sync(() => {
        drop("worker")
        restartAt = now + 30_000
      })))
    }

    yield* Effect.try({ try: () => pump(now), catch: () => undefined }).pipe(Effect.catch(() => Effect.sync(() => fail("worker"))))
  }).pipe(Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped)

  const observe = Effect.fn("ReviewHistory.observe")(function*(input: HistoryObservation) {
    yield* Effect.try({
      try: () => {
        if (stopping) return
        const event = projectHistory(input, randomUUID())

        if (event === undefined) {
          drop("oversized")

          return
        }

        const bytes = eventBytes(event)

        if (queue.length >= HISTORY_QUEUE_ROWS || queuedBytes + bytes > HISTORY_QUEUE_BYTES) {
          drop("overflow")

          return
        }

        queue.push(event)
        queuedBytes += bytes
      },
      catch: () => undefined,
    }).pipe(Effect.ignore)

    if (queue.length >= HISTORY_BATCH_ROWS || queuedBytes >= HISTORY_BATCH_BYTES) {
      const now = yield* monotonicMillis
      yield* Effect.try({ try: () => pump(now), catch: () => undefined }).pipe(Effect.ignore)
    }
  })

  return { observe } satisfies HistoryObserver
})

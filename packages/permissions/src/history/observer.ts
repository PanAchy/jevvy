import { randomUUID } from "node:crypto"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
  HISTORY_BATCH_BYTES, HISTORY_BATCH_ROWS, HISTORY_QUEUE_BYTES, HISTORY_QUEUE_ROWS,
  HistoryStorageError, eventBytes, projectHistory,
} from "../history.ts"
import type { HistoryEvent, HistoryObserver, HistoryObservation, HistoryProblem } from "../history.ts"
import { HistoryCommand, HistoryReply } from "./history-protocol.ts"
import { HistoryWorkers } from "./history-transport.ts"

export const historyProblemMessage = (kind: HistoryProblem): string => kind === "unsupported-platform"
  ? "Jevvy Permissions history is unavailable on Windows because user-only ACLs cannot be verified. Set metrics.enabled to false to dismiss this diagnostic. Permission reviews are unchanged."
  : `Jevvy Permissions history is incomplete (${kind}). Check the private global metrics directory ownership, permissions, free space and schema. Reload after correcting setup; storage failures retry after 30 seconds. Set metrics.enabled to false to disable history. Permission reviews are unchanged.`

class HistoryDiagnosticError extends Schema.TaggedError<HistoryDiagnosticError>()("HistoryDiagnosticError", {}) {}

class HistoryProjectionError extends Schema.TaggedError<HistoryProjectionError>()("HistoryProjectionError", {}) {}

interface Pending {
  readonly events: readonly HistoryEvent[]
  readonly bytes: number
}

const empty: Pending = { events: [], bytes: 0 }

const takeBatch = (pending: Pending): readonly [readonly HistoryEvent[], Pending] => {
  let bytes = 0
  let count = 0

  for (const event of pending.events) {
    const size = eventBytes(event)

    if (count === HISTORY_BATCH_ROWS || bytes + size > HISTORY_BATCH_BYTES) break
    bytes += size
    count++
  }

  return [pending.events.slice(0, count), { events: pending.events.slice(count), bytes: pending.bytes - bytes }]
}

export const createHistoryObserver = Effect.fn("ReviewHistory.createObserver")(function*(options: {
  readonly enabled: boolean
  readonly configPath: string
  readonly report: (problem: string | undefined) => void
  readonly lifetime: "invocation" | "host"
}) {
  if (!options.enabled) return undefined
  const problem = yield* Ref.make<HistoryProblem | undefined>(undefined)

  const report = Effect.fn("ReviewHistory.report")(function*(next: HistoryProblem | undefined) {
    const previous = yield* Ref.getAndSet(problem, next)

    if (previous === next) return
    yield* Effect.try({
      try: () => options.report(next === undefined ? undefined : historyProblemMessage(next)),
      catch: () => new HistoryDiagnosticError(),
    }).pipe(Effect.ignore)
  })

  if (process.platform === "win32") {
    yield* report("unsupported-platform")

    return undefined
  }

  const workers = yield* HistoryWorkers
  const pending = yield* Ref.make<Pending>(empty)
  const stopping = yield* Ref.make(false)
  const dropped = yield* Ref.make(false)
  const stopped = yield* Deferred.make<void>()
  const wake = yield* Queue.dropping<void>(1)

  const drop = Effect.fn("ReviewHistory.drop")(function*(kind: HistoryProblem) {
    yield* Ref.set(dropped, true)
    yield* report(kind)
  })

  const session = Effect.fn("ReviewHistory.session")(function*() {
    const worker = yield* workers.open(options.configPath, drop("worker"))
    const replies = yield* Queue.dropping<HistoryReply, HistoryStorageError>(1)
    const ready = yield* Deferred.make<void>()

    const receiver = yield* worker.run((raw) => Schema.decodeUnknownEffect(HistoryReply, { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError(() => new HistoryStorageError({ kind: "worker" })),
      Effect.filterOrFail((reply) => !HistoryReply.guards.Failed(reply), (reply) => new HistoryStorageError({ kind: HistoryReply.guards.Failed(reply) ? reply.kind : "worker" })),
      Effect.flatMap((reply) => Queue.offer(replies, reply)),
      Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new HistoryStorageError({ kind: "worker" }))),
    ), { onSpawn: Deferred.succeed(ready, undefined).pipe(Effect.asVoid) }).pipe(
      Effect.mapError((error) => error instanceof HistoryStorageError ? error : new HistoryStorageError({ kind: "worker" })),
      Effect.tapError((error) => Queue.fail(replies, error)),
      Effect.forkScoped,
    )

    const exchange = Effect.fn("ReviewHistory.exchange")(function*(command: HistoryCommand) {
      yield* worker.send(command).pipe(Effect.mapError(() => new HistoryStorageError({ kind: "worker" })))
      const reply = yield* Queue.take(replies)

      if (HistoryReply.guards.Failed(reply)) return yield* new HistoryStorageError({ kind: reply.kind })

      if (reply.sequence !== command.sequence || (HistoryCommand.guards.Append(command) ? !HistoryReply.guards.Stored(reply) : !HistoryReply.guards.Closed(reply))) return yield* new HistoryStorageError({ kind: "worker" })

      if (!(yield* Ref.get(dropped))) yield* report(undefined)
    })

    const sequence = yield* Ref.make(1)

    const pass = Effect.fn("ReviewHistory.drain")(function*() {
      const events = yield* Ref.modify(pending, takeBatch)
      const current = yield* Ref.get(sequence)

      if (current >= Number.MAX_SAFE_INTEGER) return yield* new HistoryStorageError({ kind: "worker" })

      if (events.length > 0) {
        yield* exchange(HistoryCommand.cases.Append.make({ sequence: current, events })).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new HistoryStorageError({ kind: "worker" })) }))
        yield* Ref.update(sequence, (value) => value + 1)

        return true
      }

      if (yield* Ref.get(stopping)) {
        yield* exchange(HistoryCommand.cases.Close.make({ sequence: current }))

        return false
      }

      yield* Queue.take(wake)

      return true
    })

    yield* Effect.raceFirst(
      Effect.gen(function*() {
        yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new HistoryStorageError({ kind: "worker" })) }))
        yield* pass().pipe(Effect.repeat({ while: (more) => more }))
      }),
      Fiber.join(receiver),
    )
  })

  const background = yield* Effect.gen(function*() {
    if (options.lifetime === "host") yield* Queue.take(wake)

    if ((yield* Ref.get(stopping)) && (yield* Ref.get(pending)).events.length === 0) return

    const attempt = Effect.scoped(session()).pipe(
      Effect.catch((error) => drop(error instanceof HistoryStorageError ? error.kind : "worker")),
      Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => drop("worker")),
    )

    yield* options.lifetime === "invocation" ? attempt : attempt.pipe(
      Effect.repeat({ schedule: Schedule.spaced("30 seconds"), while: () => Ref.get(stopping).pipe(Effect.map((value) => !value)) }),
    )
  }).pipe(
    Effect.ensuring(Deferred.succeed(stopped, undefined)),
    Effect.forkScoped,
  )

  yield* Effect.addFinalizer(() => Effect.gen(function*() {
    yield* Ref.set(stopping, true)
    yield* Queue.offer(wake, undefined)
    const drained = yield* Deferred.await(stopped).pipe(Effect.interruptible, Effect.timeoutOption("500 millis"))

    if (Option.isNone(drained)) yield* drop("worker")
    yield* Fiber.interrupt(background)
    yield* Ref.set(pending, empty)
  }))

  const observe = Effect.fn("ReviewHistory.observe")(function*(input: HistoryObservation) {
    if (yield* Ref.get(stopping)) return
    yield* Effect.gen(function*() {
      const event = yield* Effect.try({ try: () => projectHistory(input, randomUUID()), catch: () => new HistoryProjectionError() })

      if (event === undefined) {
        yield* drop("oversized")

        return
      }

      const bytes = eventBytes(event)

      const accepted = yield* Ref.modify(pending, (current): readonly [boolean, Pending] => current.events.length >= HISTORY_QUEUE_ROWS || current.bytes + bytes > HISTORY_QUEUE_BYTES
        ? [false, current]
        : [true, { events: [...current.events, event], bytes: current.bytes + bytes }])

      if (!accepted) yield* drop("overflow")
      else yield* Queue.offer(wake, undefined)
    }).pipe(Effect.catchTag("HistoryProjectionError", () => drop("worker")))
  })

  return { observe } satisfies HistoryObserver
})

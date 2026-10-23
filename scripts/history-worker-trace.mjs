import { appendFileSync, statSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import workers from "node:worker_threads"
import assert from "node:assert/strict"
import { errorMonitor } from "node:events"
import { basename } from "node:path"

const destination = new URL("./history-worker-trace.jsonl", import.meta.url)

const record = (event, fields = {}) => {
  try {
    let size = 0

    try { size = statSync(destination).size } catch {}

    if (size > 960 * 1024) return
    appendFileSync(destination, `${JSON.stringify({ pid: process.pid, thread: workers.threadId, timeMs: Number(process.hrtime.bigint()) / 1e6, event, ...fields })}\n`, { mode: 0o600 })
  } catch {}
}

if (process.env.JEVVY_SMOKE_TRACE === "1") {
  record("preload")

  if (workers.isMainThread) {
    const NativeWorker = workers.Worker
    const kinds = new Set(["unsupported-platform", "unsafe-path", "unsupported-schema", "busy", "storage", "overflow", "oversized", "worker"])

    const ids = (events) => Array.isArray(events) ? events.slice(0, 16).flatMap((entry) => {
      try {
        assert.match(entry?.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

        return [entry.id]
      } catch { return [] }
    }) : []

    const projectors = new Map([
      ["Append", (body) => ({ ids: ids(body.events) })],
      ["Failed", (body) => kinds.has(body.kind) ? { kind: body.kind } : {}],
      ...["Stored", "Close", "Closed"].map((tag) => [tag, () => ({})]),
    ])

    const fieldsByTag = new Map([
      ["Append", ["_tag", "sequence", "events"]],
      ["Failed", ["_tag", "kind"]],
      ...["Stored", "Close", "Closed"].map((tag) => [tag, ["_tag", "sequence"]]),
    ])

    const frame = (direction, value, worker) => {
      if (!Array.isArray(value)) {
        record("invalid-frame", { worker, direction })

        return
      }

      if (direction === "receive" && value.length === 1 && value[0] === 0) {
        record("platform-ready", { worker })

        return
      }

      if (value.length !== 2 || value[0] !== (direction === "send" ? 0 : 1)) {
        record("invalid-frame", { worker, direction })

        return
      }

      const body = value[1]
      const project = projectors.get(body?._tag)

      if (!project) {
        record("invalid-frame", { worker, direction })

        return
      }

      const allowed = fieldsByTag.get(body._tag)
      const keys = Object.keys(body)

      if (![Object.prototype, null].includes(Object.getPrototypeOf(body)) || keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) record("invalid-frame", { worker, direction })
      const fields = { worker, direction, tag: body._tag, ...project(body) }

      if (fields.ids && (!Array.isArray(body.events) || fields.ids.length !== body.events.length)) record("invalid-frame", { worker, direction })

      if (Number.isSafeInteger(body.sequence) && body.sequence > 0) fields.sequence = body.sequence
      record("frame", fields)
    }

    class TraceWorker extends NativeWorker {
      constructor(...args) {
        super(...args)
        this.traceId = this.threadId
        const entry = args[0] instanceof URL ? args[0].pathname : String(args[0])
        this.traceRole = ["claude-history-worker.js", "history-worker.js"].includes(basename(entry)) ? "history" : "other"
        record("spawn", { worker: this.traceId, role: this.traceRole })
        this.on("online", () => record("online", { worker: this.traceId }))
        this.on("message", (value) => frame("receive", value, this.traceId))
        this.on("messageerror", () => record("messageerror", { worker: this.traceId }))
        this.on(errorMonitor, () => record("error", { worker: this.traceId }))
        this.on("exit", (code) => record("exit", { worker: this.traceId, code }))
      }

      postMessage(value, ...args) {
        frame("send", value, this.traceId)

        try { return super.postMessage(value, ...args) }
        catch (error) { record("error", { worker: this.traceId }); throw error }
      }

      terminate(...args) {
        record("terminate", { worker: this.traceId })

        try { return super.terminate(...args) }
        catch (error) { record("error", { worker: this.traceId }); throw error }
      }
    }

    try {
      workers.Worker = TraceWorker
      syncBuiltinESMExports()
    } catch { record("patch-unavailable") }
  }
}

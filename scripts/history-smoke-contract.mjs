import assert from "node:assert/strict"
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const loadHistoryCodec = async (packageRoot) => {
  const require = createRequire(join(packageRoot, "package.json"))
  const Schema = await import(pathToFileURL(require.resolve("effect/Schema")))
  const history = await import(pathToFileURL(join(packageRoot, "dist/history.js")))
  const { historySchema } = await import(pathToFileURL(join(packageRoot, "dist/history/schema.js")))
  const { historyMetadata } = await import(pathToFileURL(join(packageRoot, "dist/history/metadata-values.js")))

  return { ...history, historySchema, historyMetadata, decode: Schema.decodeUnknownSync(history.StoredHistoryRow, { onExcessProperty: "error" }) }
}

export const readHistoryTrace = (filename) => {
  if (!filename) return undefined
  assert.ok(existsSync(filename), "Enabled history instrumentation did not write its side file")
  assert.ok(lstatSync(filename).size <= 1024 * 1024, "History trace exceeded its bound")

  return readFileSync(filename, "utf8").trim().split("\n").map((line) => {
    const entry = JSON.parse(line)
    assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0 && Number.isSafeInteger(entry.thread) && entry.thread >= 0 && Number.isFinite(entry.timeMs) && entry.timeMs >= 0)
    assert.ok(["preload", "spawn", "online", "platform-ready", "frame", "invalid-frame", "error", "messageerror", "terminate", "exit", "patch-unavailable"].includes(entry.event), "Unknown history trace event")
    assert.notEqual(entry.event, "patch-unavailable", "History instrumentation could not patch native workers")

    return entry
  })
}

export const requirePositiveWriterControl = (control) => {
  assert.equal(control.closed, true, `Sequential ${control.runtime} control must close successfully`)
  assert.deepEqual(control.sent, [control.expected.id, control.expected.id])
  assert.deepEqual(control.acknowledged, [control.expected.id, control.expected.id], "Positive controls must ACK append and duplicate")
  assert.deepEqual(control.outcomes.map(({ _tag: tag, sequence }) => [tag, sequence]), [["Stored", 1], ["Stored", 2], ["Closed", 3]])
}

export const inspectHistory = (metrics, codec) => {
  const filename = join(metrics, "history.sqlite")

  const privatePath = (path, directory) => {
    const info = lstatSync(path)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(directory ? info.isDirectory() : info.isFile(), true)
    assert.equal(info.mode & 0o777, directory ? 0o700 : 0o600)

    if (!directory) assert.equal(info.nlink, 1)

    if (process.getuid) assert.equal(info.uid, process.getuid())
  }

  if (lstatSync(metrics, { throwIfNoEntry: false })) {
    privatePath(metrics, true)

    for (const name of readdirSync(metrics)) {
      assert.ok(["history.sqlite", "history.sqlite-journal", ...Object.keys(codec.historyMetadata)].includes(name), `Unknown history file: ${name}`)
      privatePath(join(metrics, name), false)
    }

    for (const [name, content] of Object.entries(codec.historyMetadata)) {
      if (existsSync(join(metrics, name))) assert.equal(readFileSync(join(metrics, name), "utf8"), content)
    }
  }

  if (!existsSync(filename)) return { rows: [], uninitialized: "missing-database" }
  assert.ok(lstatSync(filename).size <= codec.HISTORY_DATABASE_BYTES)
  const header = readFileSync(filename)

  if (header.length > 0) {
    assert.ok(header.length >= 100 && header.length % 4096 === 0, "Invalid history file size")
    assert.equal(header.subarray(0, 16).toString(), "SQLite format 3\u0000")
    assert.equal(header.readUInt16BE(16), 4096, "Unsupported history page size")
    assert.equal(header[18], 1, "Unsupported history write format")
    assert.equal(header[19], 1, "Unsupported history read format")
  }

  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite")
  const database = new DatabaseSync(filename, { readOnly: true })

  try {
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
    const definitions = database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()

    if (definitions.length === 0) {
      const applicationId = database.prepare("PRAGMA application_id").get().application_id
      const userVersion = database.prepare("PRAGMA user_version").get().user_version
      assert.equal(applicationId, 0, "Empty schema has an initialized application identity")
      assert.equal(userVersion, 0, "Empty schema has an initialized schema version")

      try { database.prepare("SELECT * FROM events").all() }
      catch (error) { return { rows: [], uninitialized: "missing-events-table", error } }

      assert.fail("Empty SQLite schema unexpectedly contained events")
    }

    assert.equal(database.prepare("PRAGMA application_id").get().application_id, 1246058070)
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1)
    assert.deepEqual(definitions.map((row) => row.name), ["events", "events_ts", "sqlite_autoindex_events_1"])
    assert.equal(definitions[0].sql, codec.historySchema.table)
    assert.equal(definitions[1].sql, codec.historySchema.index)

    for (const [name, content] of Object.entries(codec.historyMetadata)) assert.equal(readFileSync(join(metrics, name), "utf8"), content)
    const rows = database.prepare("SELECT * FROM events ORDER BY command").all().map(codec.decode)
    assert.ok(rows.length <= codec.HISTORY_ROWS)
    assert.ok(rows.reduce((sum, row) => sum + row.event_bytes, 0) <= codec.HISTORY_LOGICAL_BYTES)

    return { rows }
  } finally { database.close() }
}

const workerProof = (events, pid, requireRole) => {
  const own = events.filter((entry) => entry.pid === pid)
  assert.ok(own.some((entry) => entry.event === "preload" && entry.thread === 0), "Missing hook preload")
  assert.equal(own.some((entry) => entry.event === "patch-unavailable"), false)
  const spawns = own.filter((entry) => entry.event === "spawn" && (entry.role === "history" || (!requireRole && entry.role === undefined)))
  assert.equal(spawns.length, 1, "Expected exactly one identified history worker for this hook")
  const worker = spawns[0].worker
  assert.ok(Number.isSafeInteger(worker) && worker > 0, "Invalid history worker identity")
  let ready = false
  let failed
  let pending
  let sequence = 0
  const sent = []
  const acknowledged = []
  let previous = -Infinity
  let terminated = false
  let ended = false
  let closed = false
  const selected = own.filter((entry) => entry.worker === worker)
  assert.equal(selected[0]?.event, "spawn", "History activity before worker spawn")

  for (const entry of selected) {
    assert.equal(entry.thread, 0, "History worker evidence must come from its parent hook thread")
    assert.ok(Number.isFinite(entry.timeMs) && entry.timeMs >= previous, "Invalid trace time order")
    previous = entry.timeMs
    assert.equal(["error", "messageerror", "invalid-frame"].includes(entry.event), false, `History transport ${entry.event}`)

    if (entry.event === "terminate") terminated = true

    if (entry.event === "exit") {
      assert.equal(ended, false, "Repeated worker exit")
      assert.ok(entry.code === 0 || (terminated && entry.code === 1), "Unexpected history worker exit")
      ended = true
    }

    if (entry.event === "platform-ready") {
      assert.equal(ready || Boolean(failed), false, "Conflicting history readiness")
      ready = true
    }

    if (entry.event !== "frame") continue
    assert.equal(ended || closed, false, "History frame after worker exit or Closed")
    assert.equal(Boolean(failed), false, "Frame after terminal failure")

    if (entry.tag === "Failed") {
      assert.equal(entry.direction, "receive")
      assert.equal(entry.kind, "busy", `Non-permitted history failure: ${entry.kind}`)
      failed = ready ? "after-ready" : "before-ready"
      continue
    }

    assert.ok(ready, "History frame before readiness")
    assert.ok(Number.isSafeInteger(entry.sequence) && entry.sequence > 0)

    if (entry.direction === "send") {
      assert.ok(["Append", "Close"].includes(entry.tag))
      assert.equal(pending, undefined, "Overlapping history exchanges")
      assert.ok(entry.sequence > sequence, "Stale history sequence")
      sequence = entry.sequence
      pending = entry

      if (entry.tag === "Append") {
        assert.ok(Array.isArray(entry.ids) && entry.ids.length > 0 && entry.ids.length <= 16)

        for (const id of entry.ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        sent.push(...entry.ids)
      }
    } else {
      assert.equal(entry.direction, "receive")
      assert.ok(pending, "Unsolicited history reply")
      assert.equal(entry.sequence, pending.sequence, "Stale history reply")
      assert.equal(entry.tag, pending.tag === "Append" ? "Stored" : "Closed")

      if (entry.tag === "Stored") acknowledged.push(...pending.ids)

      if (entry.tag === "Closed") closed = true
      pending = undefined
    }
  }

  assert.equal(sent.length, new Set(sent).size, "Repeated observation ID")

  return { pid, worker, ready, failed, sent, acknowledged }
}

export const checkHistoryCoverage = ({ expected, store, events, requireRole = false, validate = () => undefined, report = console.log }) => {
  const result = { expected: expected.length, delivered: [], missing: [], classifiedBusy: [], unknown: [], acknowledged: [], missingAcknowledged: [], uninitialized: store.uninitialized ?? null }
  const issues = []
  const rows = store.rows
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)
  assert.equal(new Set(expected.map((entry) => entry.command)).size, expected.length)

  for (const observation of expected) {
    const matched = rows.filter((row) => row.command === observation.command)

    if (matched.length === 0) result.missing.push(observation.command)
    let proof

    try {
      assert.ok(matched.length <= 1, "Duplicate hook observation")

      for (const row of matched) validate(row, observation)

      if (events) {
        proof = workerProof(events, observation.pid, requireRole)
        assert.ok(proof.sent.length <= 1, "One hook must offer exactly one observation")

        for (const id of proof.acknowledged) {
          result.acknowledged.push(id)

          if (!rows.some((row) => row.id === id)) result.missingAcknowledged.push(id)
        }

        for (const id of proof.sent) {
          const committed = rows.find((row) => row.id === id)

          if (committed) assert.equal(committed.command, observation.command, "UnACKed committed row has the wrong command")
        }

        if (matched.length > 0) assert.deepEqual(proof.sent, [matched[0].id], "Persisted hook ID differs from its Append")
      }

      if (matched.length === 0) {
        if (proof?.failed && proof.acknowledged.length === 0 && (!store.uninitialized || proof.failed === "before-ready")) result.classifiedBusy.push({ command: observation.command, pid: proof.pid, worker: proof.worker, stage: proof.failed, sent: proof.sent })
        else throw store.error ?? new Error("Unclassified missing hook observation")
      } else result.delivered.push({ command: observation.command, id: matched[0].id })

      if (store.uninitialized) assert.ok(proof?.failed === "before-ready" && !proof.ready && proof.sent.length === 0, "Missing database/table after readiness or without initialization-busy proof")
    } catch (error) {
      result.unknown.push({ command: observation.command, error: String(error) })
      issues.push(error)
    }
  }

  report(`History coverage: ${JSON.stringify({ ...result, deliveredCount: result.delivered.length, classifiedBusyCount: result.classifiedBusy.length, unknownCount: result.unknown.length, acknowledgedCount: result.acknowledged.length })}`)
  assert.equal(result.missingAcknowledged.length, 0, `Missing Stored IDs: ${JSON.stringify(result)}`)
  assert.equal(issues.length, 0, `Unexplained or invalid history: ${JSON.stringify(result)}`)
  assert.equal(result.delivered.length + result.classifiedBusy.length, expected.length)

  return result
}

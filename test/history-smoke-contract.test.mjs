import { describe, expect, it } from "vitest"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as Schema from "effect/Schema"
import * as history from "../packages/permissions/src/history.ts"
import { historySchema } from "../packages/permissions/src/history/schema.ts"
import { historyMetadata } from "../packages/permissions/src/history/metadata-values.ts"
import { HistoryReply } from "../packages/permissions/src/history/history-protocol.ts"
import { checkHistoryCoverage, inspectHistory, readHistoryTrace, requirePositiveHookHistory, requirePositiveWriterControl } from "../scripts/history-smoke-contract.mjs"

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

const command = "echo synthetic-complete && pwd > synthetic.txt"

const expected = [{ command, pid: 101 }]

const codec = { ...history, historySchema, historyMetadata, decode: Schema.decodeUnknownSync(history.StoredHistoryRow, { onExcessProperty: "error" }) }

const event = history.projectHistory({ command, result: "explicit-ask", provider: "custom", tsMs: 0, latencyMs: null }, id)

const wireRow = { id, ts: event.ts, effect: event.effect, reason: event.reason, command, model: null, latency_ms: null, detail_json: JSON.stringify(event.detail), event_bytes: history.eventBytes(event) }

const row = codec.decode(wireRow)

const trace = (stages) => [
  { pid: 101, thread: 0, timeMs: 0, event: "preload" },
  { pid: 101, thread: 0, timeMs: 1, event: "spawn", worker: 1, role: "history" },
  ...stages.map((entry, index) => ({ pid: 101, thread: 0, timeMs: index + 2, worker: 1, ...entry })),
]

const ready = { event: "platform-ready" }

const append = { event: "frame", direction: "send", tag: "Append", sequence: 1, ids: [id] }

const stored = { event: "frame", direction: "receive", tag: "Stored", sequence: 1 }

const busy = { event: "frame", direction: "receive", tag: "Failed", kind: "busy" }

const check = (options = {}) => checkHistoryCoverage({ expected, store: { rows: [] }, report: () => undefined, ...options })

const startupStop = [
  { event: "online" },
  { event: "terminate" },
  { event: "exit", code: 1 },
]

it.each([undefined, "missing-database", "missing-events-table"])("accounts for a confirmed invocation startup stop with store state %s", (uninitialized) => {
  const result = check({ lifetime: "invocation", events: trace(startupStop), store: { rows: [], uninitialized } })
  expect(result.classifiedStartup).toEqual([{ command, pid: 101, worker: 1 }])
  expect(result.delivered).toEqual([])
  expect(result.acknowledged).toEqual([])
  expect(result.unknown).toEqual([])
})

it("replays the captured CI pre-readiness shutdown without claiming delivery", () => {
  const events = [
    { pid: 3289, thread: 0, timeMs: 73790.922142, event: "preload" },
    { pid: 3289, thread: 0, timeMs: 73898.259901, event: "spawn", worker: 1, role: "history" },
    { pid: 3289, thread: 1, timeMs: 73937.120424, event: "preload" },
    { pid: 3289, thread: 0, timeMs: 73992.236809, event: "online", worker: 1 },
    { pid: 3289, thread: 0, timeMs: 74396.713572, event: "terminate", worker: 1 },
    { pid: 3289, thread: 0, timeMs: 74401.432261, event: "exit", worker: 1, code: 1 },
  ]

  const result = check({ expected: [{ command, pid: 3289 }], lifetime: "invocation", events, requireRole: true })

  expect(result.classifiedStartup).toEqual([{ command, pid: 3289, worker: 1 }])
  expect(result.delivered).toEqual([])
})

it("does not permit a startup stop for a live host worker", () => {
  expect(() => check({ events: trace(startupStop) })).toThrow(/Unexplained/)
})

it.each([
  [{ event: "terminate" }],
  [{ event: "exit", code: 1 }],
  [{ event: "exit", code: 0 }, { event: "terminate" }],
  [{ event: "terminate" }, { event: "exit", code: 0 }],
  [ready, ...startupStop],
  [ready, append, ...startupStop],
  [{ event: "error" }, ...startupStop],
  [{ event: "messageerror" }, ...startupStop],
  [{ event: "invalid-frame" }, ...startupStop],
  [{ event: "terminate" }, ready, { event: "exit", code: 1 }],
  [{ event: "terminate" }, { event: "terminate" }, { event: "exit", code: 1 }],
].map((stages) => [stages]))("keeps incomplete or conflicting shutdown evidence red", (stages) => {
  expect(() => check({ lifetime: "invocation", events: trace(stages) })).toThrow(/Unexplained/)
})

it("a startup stop in another hook cannot excuse the missing observation", () => {
  expect(() => check({ lifetime: "invocation", events: trace(startupStop).map((entry) => ({ ...entry, pid: 102 })) })).toThrow(/Unexplained/)
})

it("shutdown cannot excuse an acknowledged but missing row", () => {
  expect(() => check({ lifetime: "invocation", events: trace([ready, append, stored, ...startupStop]) })).toThrow(/Missing Stored IDs/)
})

it("requires actual hook writes rather than accepting a suite of classified drops", () => {
  const startup = check({ lifetime: "invocation", events: trace(startupStop) })
  const busyDrop = check({ events: trace([busy]) })
  const delivered = check({ store: { rows: [row] }, events: trace([ready, append, stored]) })
  const unacknowledged = check({ store: { rows: [row] }, events: trace([ready, append, busy]) })
  expect(() => requirePositiveHookHistory({ coverages: [undefined, startup, busyDrop], requireAck: true })).toThrow(/must persist/)
  expect(() => requirePositiveHookHistory({ coverages: [unacknowledged], requireAck: true })).toThrow(/must persist/)
  expect(() => requirePositiveHookHistory({ coverages: [startup, delivered], requireAck: true })).not.toThrow()
  expect(() => requirePositiveHookHistory({ coverages: [unacknowledged], requireAck: false })).not.toThrow()
})

it.each([
  ["before Ready", [busy], "before-ready"],
  ["after Append without ACK", [ready, append, busy], "after-ready"],
])("accepts and reports only exact-worker explicit busy %s", (_, stages, stage) => {
  const reports = []
  const result = check({ events: trace(stages), report: (text) => reports.push(text) })
  expect(result.missing).toEqual([command])
  expect(result.classifiedBusy).toEqual([{ command, pid: 101, worker: 1, stage, sent: stage === "before-ready" ? [] : [id] }])
  expect(result.unknown).toEqual([])
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('"classifiedBusyCount":1')
})

it.each([undefined, [], trace([]), trace([ready]), trace([ready, append]), trace([{ event: "terminate" }]), trace([busy]).map((entry) => ({ ...entry, pid: 102 }))].map((events) => [events]))("rejects an unexplained missing observation even with termination or another PID's busy", (events) => {
  expect(() => check({ events })).toThrow(/Unexplained/)
})

it.each(["unsafe-path", "unsupported-schema", "worker", "storage", "overflow", "oversized", "unsupported-platform"])("does not expand permitted failures to %s", (kind) => {
  expect(() => check({ events: trace([{ ...busy, kind }]) })).toThrow(/Non-permitted/)
})

it("missing ACKed UUID stays red even if another explicit busy follows", () => {
  expect(() => check({ events: trace([ready, append, stored, busy]) })).toThrow(/Missing Stored IDs/)
})

it.each([
  [ready, append, { ...stored, sequence: 2 }],
  [ready, append, stored, { ...append, sequence: 1 }],
  [ready, append, stored, stored],
  [ready, append, busy, stored],
  [busy, ready],
  [{ event: "error" }, busy],
  [{ event: "messageerror" }, busy],
  [{ event: "invalid-frame" }, busy],
  [busy, { event: "exit", code: 2 }],
  [{ event: "exit", code: 0 }, busy],
  [busy, { event: "exit", code: 1 }],
  [{ ...busy, timeMs: -1 }],
].map((stages) => [stages]))("rejects bad ordering, sequence, transport or conflicting Stored evidence", (stages) => {
  expect(() => check({ events: trace(stages) })).toThrow(/Unexplained/)
})

it("never claims rollback for an unACKed committed row after busy", () => {
  const result = check({ events: trace([ready, append, busy]), store: { rows: [row] }, validate: (actual) => assert.deepEqual(actual, row) })
  expect(result.delivered).toEqual([{ command, id }])
  expect(result.acknowledged).toEqual([])
  expect(result.classifiedBusy).toEqual([])
})

it("rejects a committed unACKed UUID whose original command was changed", () => {
  const changed = { ...event, command: "echo different-original-command" }
  const changedRow = codec.decode({ ...wireRow, command: changed.command, event_bytes: history.eventBytes(changed) })
  expect(() => check({ events: trace([ready, append, busy]), store: { rows: [changedRow] } })).toThrow(/wrong command/)
})

it("requires intact original payload even with valid ACK and otherwise matching row codec", () => {
  expect(() => check({ events: trace([ready, append, stored]), store: { rows: [{ ...row, model: "wrong-model" }] }, validate: (actual) => assert.deepEqual(actual, row) })).toThrow(/Unexplained/)
})

it.each(["missing-database", "missing-events-table"])("accepts %s only with pre-ready initialization busy and no ACK", (uninitialized) => {
  expect(check({ events: trace([busy]), store: { rows: [], uninitialized } }).classifiedBusy).toHaveLength(1)

  for (const events of [undefined, trace([]), trace([ready, append, busy]), trace([ready, append, stored, busy])]) {
    expect(() => check({ events, store: { rows: [], uninitialized } })).toThrow()
  }
})

it("reports all cold drops without treating them as positive persistence proof", () => {
  const second = { command: "echo second-synthetic", pid: 102 }
  const result = check({ expected: [...expected, second], events: [...trace([busy]), ...trace([busy]).map((entry) => ({ ...entry, pid: 102 }))] })
  expect(result.delivered).toEqual([])
  expect(result.missing).toEqual([command, second.command])
  expect(result.classifiedBusy).toHaveLength(2)
  expect(result.acknowledged).toEqual([])
  expect(() => requirePositiveWriterControl({ runtime: "node", closed: false, expected: event, sent: [], acknowledged: [], outcomes: [HistoryReply.cases.Failed.make({ kind: "busy" })] })).toThrow()
  expect(() => requirePositiveWriterControl({ runtime: "bun", closed: true, expected: event, sent: [id, id], acknowledged: [id], outcomes: [HistoryReply.cases.Stored.make({ sequence: 1 }), HistoryReply.cases.Closed.make({ sequence: 3 })] })).toThrow()
})

it.each(["command", "model", "answer"])("positive control rejects a schema-valid changed %s", (field) => {
  const original = history.projectHistory({
    command, provider: "custom", tsMs: 0, latencyMs: 3,
    result: { effect: "allow", judgments: [{ resource: command, effect: "allow", model: "actual-control", answers: { synthetic: { type: "noul", noul: 0.25 } } }] },
  }, id)

  const control = { runtime: "node", closed: true, expected: original, sent: [id, id], acknowledged: [id, id], outcomes: [HistoryReply.cases.Stored.make({ sequence: 1 }), HistoryReply.cases.Stored.make({ sequence: 2 }), HistoryReply.cases.Closed.make({ sequence: 3 })] }

  const stored = (value) => codec.decode({
    id: value.id, ts: value.ts, effect: value.effect, reason: value.reason, command: value.command,
    model: value.model, latency_ms: value.latencyMs, detail_json: JSON.stringify(value.detail), event_bytes: history.eventBytes(value),
  })

  expect(() => requirePositiveWriterControl(control, stored(original), history.eventBytes)).not.toThrow()

  const changed = field === "answer"
    ? { ...original, detail: { ...original.detail, answers: { synthetic: { type: "noul", noul: 0.75 } } } }
    : { ...original, [field]: `different-${field}` }

  const validChangedRow = stored(changed)
  expect(() => requirePositiveWriterControl(control, validChangedRow, history.eventBytes)).toThrow(/complete original payload/)
})

it("ignores explicitly unrelated host workers but requires the history role when requested", () => {
  const unrelated = trace([{ event: "error" }]).map((entry) => ({ ...entry, worker: 2, role: "other" }))
  expect(check({ events: [...trace([busy]), ...unrelated], requireRole: true }).classifiedBusy).toHaveLength(1)
  expect(() => check({ events: trace([busy]).map(({ role: _role, ...entry }) => entry), requireRole: true })).toThrow()
})

it.each([["worker", "not-a-worker-id"], ["thread", 1]])("rejects invalid worker evidence %s", (field, value) => {
  const events = trace([busy]).map((entry) => entry.worker === undefined ? entry : { ...entry, [field]: value })
  expect(() => check({ events })).toThrow(/Unexplained/)
})

const fixture = (use) => {
  const root = mkdtempSync(join(tmpdir(), "jevvy-contract-test-"))

  try { return use(root) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

it("enabled tracing cannot silently disappear or become empty", () => fixture((root) => {
  const filename = join(root, "trace.jsonl")
  expect(() => readHistoryTrace(filename)).toThrow(/did not write/)
  writeFileSync(filename, "")
  expect(() => readHistoryTrace(filename)).toThrow()
  writeFileSync(filename, JSON.stringify({ pid: 101, thread: 0, timeMs: 1, event: "patch-unavailable" }))
  expect(() => readHistoryTrace(filename)).toThrow(/could not patch/)
  expect(readHistoryTrace(undefined)).toBeUndefined()
}))

describe.skipIf(process.platform === "win32")("strict read-only initialized store gate", () => {
  it("rejects a dangling metrics symlink even with pre-ready busy evidence", () => fixture((root) => {
    const metrics = join(root, "metrics")
    symlinkSync(join(root, "missing-store"), metrics)
    expect(() => check({ events: trace([busy]), store: inspectHistory(metrics, codec) })).toThrow()
  }))

  const initialize = (root) => {
    const metrics = join(root, "metrics")
    mkdirSync(metrics, { mode: 0o700 })
    const filename = join(metrics, "history.sqlite")
    const database = new DatabaseSync(filename)
    database.exec(`PRAGMA application_id=1246058070; PRAGMA user_version=1; ${historySchema.table}; ${historySchema.index}`)
    database.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(wireRow))
    database.close()
    chmodSync(filename, 0o600)

    for (const [name, content] of Object.entries(historyMetadata)) writeFileSync(join(metrics, name), content, { mode: 0o600 })

    return { metrics, filename }
  }

  it("fully decodes exact data, metadata, SQL, bounds and private paths without writes", () => fixture((root) => {
    const { metrics, filename } = initialize(root)
    const bytes = readFileSync(filename)
    expect(inspectHistory(metrics, codec)).toEqual({ rows: [row] })
    expect(readFileSync(filename)).toEqual(bytes)
  }))

  it.each(["versioned-empty-schema", "noncanonical-page-size", "wal-header"])("rejects unsupported %s before accepting busy or touching the store", (kind) => fixture((root) => {
    const metrics = join(root, "metrics")
    mkdirSync(metrics, { mode: 0o700 })
    const filename = join(metrics, "history.sqlite")
    const database = new DatabaseSync(filename)

    if (kind === "noncanonical-page-size") database.exec("PRAGMA page_size=8192")
    database.exec("PRAGMA application_id=1246058070; PRAGMA user_version=1")

    if (kind !== "versioned-empty-schema") database.exec(`${historySchema.table}; ${historySchema.index}`)

    if (kind === "wal-header") database.exec("PRAGMA journal_mode=WAL")
    database.close()
    chmodSync(filename, 0o600)

    for (const [name, content] of Object.entries(historyMetadata)) writeFileSync(join(metrics, name), content, { mode: 0o600 })
    const bytes = readFileSync(filename)
    const entries = readdirSync(metrics)
    expect(() => check({ store: inspectHistory(metrics, codec), events: trace([busy]) })).toThrow()
    expect(readdirSync(metrics)).toEqual(entries)
    expect(readFileSync(filename)).toEqual(bytes)
  }))

  it.each(["event-bytes", "raw-answer", "schema", "version", "metadata", "mode", "corruption"])("rejects %s instead of classifying store damage as busy", (kind) => fixture((root) => {
    const { metrics, filename } = initialize(root)
    const database = new DatabaseSync(filename)

    if (kind === "event-bytes") database.exec("UPDATE events SET event_bytes=2")

    if (kind === "raw-answer") database.exec(`UPDATE events SET detail_json='{"version":1,"provider":null,"answers":{"bad":{"type":"noul","noul":2}},"failure":null}'`)

    if (kind === "schema") database.exec("CREATE TABLE unknown(value)")

    if (kind === "version") database.exec("PRAGMA user_version=2")
    database.close()

    if (kind === "metadata") writeFileSync(join(metrics, "AGENTS.md"), "wrong")

    if (kind === "mode") chmodSync(filename, 0o644)

    if (kind === "corruption") writeFileSync(filename, "not-a-database")
    expect(() => inspectHistory(metrics, codec)).toThrow()
  }))

  it("does not blindly convert no database/table into success or repair the store", () => fixture((root) => {
    const metrics = join(root, "metrics")
    expect(() => check({ store: inspectHistory(metrics, codec) })).toThrow()
    mkdirSync(metrics, { mode: 0o700 })
    const filename = join(metrics, "history.sqlite")
    const database = new DatabaseSync(filename)
    database.close()
    chmodSync(filename, 0o600)
    const before = readFileSync(filename)
    const store = inspectHistory(metrics, codec)
    expect(store.uninitialized).toBe("missing-events-table")
    expect(() => check({ store })).toThrow()
    expect(check({ store, events: trace([busy]) }).classifiedBusy).toHaveLength(1)
    expect(readFileSync(filename)).toEqual(before)
  }))
})

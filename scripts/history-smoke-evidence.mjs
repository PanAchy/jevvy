import { chownSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const limits = {
  "history.sqlite": 32 * 1024 * 1024,
  "history.sqlite-journal": 40 * 1024 * 1024,
  "AGENTS.md": 65_536,
  "schema.sql": 65_536,
  "event.schema.json": 65_536,
}

export const prepareHistoryTrace = (directory, enabled = process.env.JEVVY_SMOKE_TRACE === "1") => {
  if (!enabled) return { args: [], env: {}, file: undefined }
  const preload = join(directory, "history-worker-trace.mjs")
  copyFileSync(new URL("./history-worker-trace.mjs", import.meta.url), preload)

  return { args: ["--import", pathToFileURL(preload).href], env: { JEVVY_SMOKE_TRACE: "1" }, file: join(directory, "history-worker-trace.jsonl") }
}

const errorDetail = (error, depth = 0) => {
  const detail = { name: error?.name, message: error?.message?.slice(0, 32768), stack: error?.stack?.slice(0, 65536), code: error?.code }

  if (error?.cause && depth < 2) detail.cause = errorDetail(error.cause, depth + 1)

  return detail
}

const snapshotFile = (source, target, maximum) => {
  const info = lstatSync(source)
  const metadata = { size: info.size, mode: info.mode & 0o777, links: info.nlink, regular: info.isFile(), symlink: info.isSymbolicLink() }

  if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (process.getuid && info.uid !== process.getuid())) return { ...metadata, copied: false }
  const descriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))

  try {
    const opened = fstatSync(descriptor)

    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== info.uid || opened.nlink !== 1 || opened.size > maximum) return { ...metadata, copied: false }
    const data = Buffer.alloc(opened.size)
    let bytes = 0

    while (bytes < data.length) {
      const count = readSync(descriptor, data, bytes, Math.min(65_536, data.length - bytes), null)

      if (count === 0) break
      bytes += count
    }

    writeFileSync(target, data.subarray(0, bytes), { mode: 0o600, flag: "wx" })

    return { ...metadata, copied: true, bytes }
  } finally { closeSync(descriptor) }
}

const inspectDatabase = async (filename) => {
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(filename, { readOnly: true })

  try {
    const result = {}

    for (const [key, query] of Object.entries({
      applicationId: "PRAGMA application_id",
      userVersion: "PRAGMA user_version",
      objects: "SELECT type, substr(name,1,128) AS name, substr(sql,1,4096) AS sql FROM sqlite_schema ORDER BY name LIMIT 16",
      rows: "SELECT substr(id,1,128) AS id, substr(ts,1,64) AS ts, substr(effect,1,16) AS effect, substr(reason,1,32) AS reason, substr(command,1,4096) AS command, substr(model,1,512) AS model, substr(CAST(latency_ms AS TEXT),1,64) AS latency_ms, substr(detail_json,1,8192) AS detail_json, substr(CAST(event_bytes AS TEXT),1,64) AS event_bytes FROM events ORDER BY command LIMIT 32",
    })) {
      try { result[key] = database.prepare(query).all() }
      catch (error) { result[`${key}Error`] = errorDetail(error) }
    }

    return result
  } finally { database.close() }
}

export const captureHistoryFailure = async (options, failure) => {
  try {
    const output = options.outputRoot ?? fileURLToPath(new URL("../.agents/smoke-artifacts/", import.meta.url))
    mkdirSync(output, { recursive: true, mode: 0o700 })

    if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) return undefined
    const directory = mkdtempSync(join(output, "history-"))
    const metrics = join(directory, "metrics")
    mkdirSync(metrics, { mode: 0o700 })
    const summary = { runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, failure: errorDetail(failure), invocations: options.invocations, files: Object.create(null), rowLimit: 32, stringLimits: { command: 4096, detailJson: 8192, model: 512, numericPreview: 64 } }
    writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })

    try {
      const root = lstatSync(options.metricsPath)
      summary.metrics = { directory: root.isDirectory(), symlink: root.isSymbolicLink(), mode: root.mode & 0o777 }

      if (root.isDirectory() && !root.isSymbolicLink()) {
        const entries = opendirSync(options.metricsPath)

        try {
          for (let index = 0; index < 32; index++) {
            const entry = entries.readSync()

            if (entry === null) break
            const name = entry.name

            try {
              if (Object.hasOwn(limits, name)) summary.files[name] = snapshotFile(join(options.metricsPath, name), join(metrics, name), limits[name])
              else {
                const info = lstatSync(join(options.metricsPath, name))
                summary.files[name.slice(0, 128)] = { unsupported: true, size: info.size, mode: info.mode & 0o777, links: info.nlink, symlink: info.isSymbolicLink() }
              }
            } catch (error) { summary.files[name.slice(0, 128)] = { captureError: error?.code ?? "capture" } }

            if (index === 31) summary.entriesTruncated = true
          }
        } finally { entries.closeSync() }
      }
    } catch (error) { summary.metricsError = errorDetail(error) }

    if (options.tracePath) {
      try { summary.trace = snapshotFile(options.tracePath, join(directory, "worker-trace.jsonl"), 1024 * 1024) }
      catch (error) { summary.traceError = { code: error?.code ?? "capture" } }
    }

    if (summary.files["history.sqlite"]?.copied) {
      try { summary.database = await inspectDatabase(join(metrics, "history.sqlite")) }
      catch (error) { summary.databaseError = errorDetail(error) }
    }

    writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })

    if (Number.isSafeInteger(options.owner?.uid) && Number.isSafeInteger(options.owner?.gid)) {
      const paths = Object.entries(summary.files).filter(([, info]) => info.copied).map(([name]) => join(metrics, name))

      if (summary.trace?.copied) paths.push(join(directory, "worker-trace.jsonl"))
      paths.push(join(directory, "summary.json"), metrics, directory)

      for (const path of paths) chownSync(path, options.owner.uid, options.owner.gid)
    }

    return directory
  } catch { return undefined }
}

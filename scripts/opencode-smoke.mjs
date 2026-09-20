#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const temporary = mkdtempSync(join(tmpdir(), "jevvy-opencode-smoke-"))

try {
  const pack = spawnSync(
    "npm",
    ["pack", "--workspace=@jevvy/permissions", "--pack-destination", temporary],
    { cwd: root, encoding: "utf8" },
  )

  if (pack.status !== 0) throw new Error(`package build failed\n${pack.stdout}\n${pack.stderr}`)

  const tarball = readdirSync(temporary).find((name) => name.endsWith(".tgz"))

  if (tarball === undefined) throw new Error("package build produced no tarball")

  const docker = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--network",
      "host",
      "--volume",
      `${join(temporary, tarball)}:/tmp/jevvy.tgz:ro`,
      "--volume",
      `${join(root, "scripts", "opencode-smoke-container.mjs")}:/tmp/smoke.mjs:ro`,
      "node:24-bookworm-slim",
      "node",
      "/tmp/smoke.mjs",
    ],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  )

  if (docker.status !== 0) throw new Error(`OpenCode container smoke returned ${String(docker.status)}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

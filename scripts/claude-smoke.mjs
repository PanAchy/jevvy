#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const claude = process.env.CLAUDE_BIN ?? "claude"

const temporary = mkdtempSync(join(tmpdir(), "jevvy-claude-smoke-"))

const environment = { ...process.env, CLAUDE_CONFIG_DIR: temporary }

const runClaude = (arguments_, stdio = "pipe") => spawnSync(claude, arguments_, {
  cwd: root,
  encoding: "utf8",
  env: environment,
  stdio,
})

const validate = (path, allowedWarnings = []) => {
  const result = runClaude(["plugin", "validate", path, "--json"])

  if (result.status !== 0) throw new Error(`Claude Code rejected ${path}: ${result.stderr || result.stdout}`)

  const report = JSON.parse(result.stdout)

  const warnings = [
    ...(report.manifest?.warnings ?? []),
    ...(report.contents ?? []).flatMap((content) => content.warnings ?? []),
  ]

  const unexpected = warnings.filter((warning) => !allowedWarnings.includes(warning.path))

  if (unexpected.length > 0) {
    throw new Error(`Claude Code reported unexpected warnings for ${path}: ${JSON.stringify(unexpected)}`)
  }
}

try {
  const plugin = join(root, "packages", "permissions")

  validate(plugin, ["version"])

  validate(join(root, ".claude-plugin", "marketplace.json"))

  const loaded = runClaude(["--plugin-dir", plugin, "plugin", "list", "--json"])

  if (loaded.status !== 0) throw new Error(`Claude Code failed to load the plugin: ${loaded.stderr}`)

  const plugins = JSON.parse(loaded.stdout)
  const jevvy = plugins.find((candidate) => candidate.id === "jevvy-permissions@inline")

  if (jevvy?.enabled !== true || jevvy.scope !== "session") {
    throw new Error("Claude Code did not load jevvy-permissions as an enabled session plugin")
  }

  console.log("Claude Code host smoke passed: jevvy-permissions enabled in an isolated host")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const temporary = mkdtempSync(join(tmpdir(), "jevvy-claude-permission-pack-"))

try {
  const pack = spawnSync("npm", ["pack", "--workspace=@jevvy/permissions", "--pack-destination", temporary], {
    cwd: root,
    encoding: "utf8",
  })

  if (pack.status !== 0) throw new Error(`package build failed\n${pack.stdout}\n${pack.stderr}`)

  const artifact = readdirSync(temporary).find((name) => name.endsWith(".tgz"))

  if (artifact === undefined) throw new Error("package build produced no tarball")

  const smoke = spawnSync(process.execPath, [join(root, "scripts", "claude-permission-smoke.mjs"), join(temporary, artifact)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  })

  if (smoke.status !== 0) throw new Error(`Claude permission smoke returned ${String(smoke.status)}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

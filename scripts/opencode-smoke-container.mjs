#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = "/tmp/jevvy-opencode-smoke"

const project = join(root, "project")

const home = join(root, "home")

mkdirSync(project, { recursive: true })

mkdirSync(home, { recursive: true })

writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))

const install = spawnSync(
  "npm",
  ["install", "--no-audit", "--no-fund", "--ignore-scripts=false", "/tmp/jevvy.tgz", "@opencode/cli@2.0.8"],
  {
    cwd: root,
    env: {
      ...process.env,
      npm_config_fetch_retries: "1",
      npm_config_fetch_retry_maxtimeout: "10000",
      npm_config_fetch_timeout: "30000",
    },
    stdio: "inherit",
    timeout: 240_000,
  },
)

if (install.status !== 0) throw new Error(`consumer install failed with status ${String(install.status)}`)

const serverPassword = "jevvy-host-smoke"

const authorization = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`

writeFileSync(join(project, "opencode.jsonc"), `${JSON.stringify({ plugins: ["@jevvy/permissions"] }, null, 2)}\n`)

writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({ provider: "typesafe" }, null, 2)}\n`, { mode: 0o600 })

const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  JEVVY_CONFIG: join(root, "jevvy.jsonc"),
  OPENCODE_PASSWORD: serverPassword,
  OPENCODE_API_KEY: "",
  TYPESAFE_API_KEY: "",
  NO_COLOR: "1",
}

const executable = join(root, "node_modules", ".bin", "opencode")

const server = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
  cwd: project,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
})

const diagnostics = []

server.stdout.on("data", (chunk) => diagnostics.push(String(chunk)))

server.stderr.on("data", (chunk) => diagnostics.push(String(chunk)))

const waitForServer = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:4096/api/info", {
        headers: { authorization },
      })

      if (response.ok) return
    } catch {
      // The foreground server is still starting.
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }

  throw new Error(`OpenCode did not start\n${diagnostics.join("").slice(-4000)}`)
}

try {
  await waitForServer()

  const session = await fetch("http://127.0.0.1:4096/api/session", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: project } }),
  })

  if (!session.ok) throw new Error(`session creation failed: ${session.status} ${await session.text()}`)

  const url = new URL("http://127.0.0.1:4096/api/plugin")

  url.searchParams.set("location[directory]", project)

  let lastBody

  let active = false

  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(url, { headers: { authorization } })

    if (!response.ok) throw new Error(`plugin status failed: ${response.status} ${await response.text()}`)

    lastBody = await response.json()

    const plugin = lastBody.data?.find((entry) => entry.id === "jevvy.permissions")

    if (plugin?.state?.status === "active") {
      console.log("OpenCode host smoke passed: jevvy.permissions active without credentials")

      active = true
      break
    }

    if (plugin?.state?.status === "failed") {
      throw new Error(`Jevvy plugin failed: ${JSON.stringify(plugin)}\n${diagnostics.join("").slice(-4000)}`)
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }

  if (!active) {
    throw new Error(`Jevvy plugin did not activate: ${JSON.stringify(lastBody)}\n${diagnostics.join("").slice(-4000)}`)
  }
} finally {
  server.kill("SIGTERM")
}

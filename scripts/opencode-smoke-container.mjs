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

const inspectPlugin = async (port, expectedStatus, expectedError) => {
  const server = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const diagnostics = []

  server.stdout.on("data", (chunk) => diagnostics.push(String(chunk)))
  server.stderr.on("data", (chunk) => diagnostics.push(String(chunk)))

  try {
    const baseUrl = `http://127.0.0.1:${port}`

    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/api/info`, { headers: { authorization } })

        if (response.ok) break
      } catch {
        // The foreground server is still starting.
      }

      if (attempt === 119) throw new Error(`OpenCode did not start\n${diagnostics.join("").slice(-4000)}`)

      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }

    const session = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: project } }),
    })

    if (!session.ok) throw new Error(`session creation failed: ${session.status} ${await session.text()}`)

    const url = new URL(`${baseUrl}/api/plugin`)

    url.searchParams.set("location[directory]", project)

    let lastPlugin

    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(url, { headers: { authorization } })

      if (!response.ok) throw new Error(`plugin status failed: ${response.status} ${await response.text()}`)

      const body = await response.json()

      lastPlugin = body.data?.find((entry) => entry.id === "jevvy.permissions")

      if (lastPlugin?.state?.status === expectedStatus) {
        if (expectedError !== undefined && !lastPlugin.state.error?.includes(expectedError)) {
          throw new Error(`Jevvy plugin error was not actionable: ${JSON.stringify(lastPlugin)}`)
        }

        return
      }

      if (lastPlugin?.state?.status === "failed") {
        throw new Error(`Jevvy plugin failed unexpectedly: ${JSON.stringify(lastPlugin)}`)
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }

    throw new Error(`Jevvy plugin did not reach ${expectedStatus}: ${JSON.stringify(lastPlugin)}\n${diagnostics.join("").slice(-4000)}`)
  } finally {
    server.kill("SIGTERM")

    if (server.exitCode === null) await new Promise((resolveExit) => server.once("exit", resolveExit))
  }
}

await inspectPlugin(4096, "failed", "npx @jevvy/permissions init")

writeFileSync(join(root, "jevvy.jsonc"), `${JSON.stringify({
  provider: "custom",
  providers: {
    custom: {
      endpoint: "http://127.0.0.1:9/v1/decisions",
      model: "smoke-model",
    },
  },
}, null, 2)}\n`, { mode: 0o600 })

await inspectPlugin(4097, "active")

console.log("OpenCode host smoke passed: setup failures are actionable and configured no-key endpoints activate")

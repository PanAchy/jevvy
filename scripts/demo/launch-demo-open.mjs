import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { strict as assert } from "node:assert"

const here = dirname(fileURLToPath(import.meta.url))

const plugin = process.env.JEVVY_PLUGIN_DIR

const root = process.env.DEMO_ROOT ?? mkdtempSync(join(tmpdir(), "jevvy-demo-"))

const media = join(root, "media")

const calls = []

let scenario = "ask"

if (plugin === undefined || plugin.length === 0) throw new Error("JEVVY_PLUGIN_DIR is required")

mkdirSync(media, { recursive: true })

const server = createServer(async (request, response) => {
  let body = ""

  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  calls.push(parsed)
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({
    model: "test",
    answers: Object.fromEntries(Object.keys(parsed.questions).map((key) => [key, { type: "noul", noul: scenario === "abstain" && key === "harmful" ? 1 : 0 }])),
  }))
})

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const config = join(root, "jevvy.jsonc")
  writeFileSync(config, JSON.stringify({ provider: "custom", providers: { custom: { endpoint: `http://127.0.0.1:${port}/decisions`, model: "test" } } }))

  for (const mode of ["ask", "allow", "abstain"]) {
    scenario = mode

    const child = spawn("opencode-drive", ["run", join(here, "demo-open.ts")], {
      env: {
        ...process.env,
        DEMO_SCENARIO: mode,
        DEMO_ROOT: root,
        JEVVY_CONFIG: config,
        JEVVY_PLUGIN_DIR: plugin,
        OPENCODE_DRIVE_MEDIA_DIR: media,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let output = ""
    let errors = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { errors += chunk })
    const status = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject) })
    console.log(`mode=${mode}, drive status=${status}, provider calls=${calls.length}`)
    console.log(output.slice(-6000))
    console.log(errors.slice(-2000))
    assert.equal(status, 0)

    if (mode === "ask") assert.equal(calls.length, 0)

    if (mode === "allow") {
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].state, { action: "shell", resource: "node -p process.version && pwd" })
    }

    if (mode === "abstain") {
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[1].state, { action: "shell", resource: "git reset --hard HEAD" })
    }
  }

  console.log(`OpenCode isolated host: all three demo outcomes verified\nmedia: ${media}`)
} finally {
  await new Promise((resolve) => server.close(resolve))

  if (process.env.DEMO_ROOT === undefined) rmSync(root, { recursive: true, force: true })
}

#!/usr/bin/env node

// Pack the public permissions product, install it as a consumer, and verify
// both internal workspaces remain implementation details.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInitSmoke } from "./init-smoke.mjs"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

const temporary = mkdtempSync(join(tmpdir(), "jevvy-package-smoke-"))

const npmUserConfig = join(temporary, ".npmrc")

writeFileSync(npmUserConfig, "")

const npmEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_config_allow_scripts"),
)

npmEnvironment.NPM_CONFIG_USERCONFIG = npmUserConfig

const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}

const npmCli = process.env.npm_execpath

ensure(npmCli !== undefined, "package smoke must be run through npm")

const runNpm = (arguments_, options) => execFileSync(process.execPath, [npmCli, ...arguments_], options)

const collectDependencyVersions = (dependencies, packageName, versions = new Set()) => {
  if (dependencies === undefined) return versions

  for (const [name, dependency] of Object.entries(dependencies)) {
    if (name === packageName) versions.add(dependency.version)

    collectDependencyVersions(dependency.dependencies, packageName, versions)
  }

  return versions
}

const expectedPlatform = process.env.JEVVY_EXPECT_PLATFORM

const expectedArchitecture = process.env.JEVVY_EXPECT_ARCH

if (expectedPlatform !== undefined) {
  ensure(process.platform === expectedPlatform, `expected platform ${expectedPlatform}, received ${process.platform}`)
}

if (expectedArchitecture !== undefined) {
  ensure(process.arch === expectedArchitecture, `expected architecture ${expectedArchitecture}, received ${process.arch}`)
}

try {
  const packDirectory = join(temporary, "pack")

  mkdirSync(packDirectory)

  runNpm(["pack", "--workspace=@jevvy/permissions", "--pack-destination", packDirectory], {
    cwd: repo,
    env: npmEnvironment,
    stdio: "pipe",
  })

  const tarballs = readdirSync(packDirectory)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(packDirectory, name))

  ensure(tarballs.length === 1, `expected one tarball, found ${tarballs.length}`)

  for (const tarball of tarballs) ensure(statSync(tarball).size < 1_000_000, `${tarball} unexpectedly exceeds 1 MB`)

  const consumer = join(temporary, "consumer")

  mkdirSync(consumer)
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
  runNpm(["install", "--no-audit", "--no-fund", ...tarballs], {
    cwd: consumer,
    env: npmEnvironment,
    stdio: "pipe",
  })

  const permissionsRoot = join(consumer, "node_modules", "@jevvy", "permissions")
  const coreBundle = join(permissionsRoot, "dist", "core.js")
  const claudeBundle = join(permissionsRoot, "dist", "claude-hook.js")
  const claudeManifest = JSON.parse(readFileSync(join(permissionsRoot, ".claude-plugin", "plugin.json"), "utf8"))
  const claudeHooks = JSON.parse(readFileSync(join(permissionsRoot, "hooks", "hooks.json"), "utf8"))
  const readme = readFileSync(join(permissionsRoot, "README.md"), "utf8")

  ensure(existsSync(coreBundle), "permissions is missing its bundled core")
  const core = await import(pathToFileURL(coreBundle))
  const schemas = await import(pathToFileURL(join(permissionsRoot, "dist", "core-schemas.js")))

  for (const name of ["JevProvider", "JevProviderErrorKind", "NoulAnswer"]) ensure(core[name] === schemas[name], `packed schema-only entry duplicated ${name}`)

  const metadataPath = join(permissionsRoot, "dist", "history", "metadata-values.js")
  const { historyMetadata } = await import(pathToFileURL(metadataPath))
  const { createHistoryMetadata } = await import(pathToFileURL(join(permissionsRoot, "dist", "history", "metadata.js")))

  ensure(Object.isFrozen(historyMetadata), "packed history metadata is mutable")
  ensure(JSON.stringify(historyMetadata) === JSON.stringify(createHistoryMetadata()), "packed history metadata differs from the authoritative schemas")
  ensure(!readFileSync(metadataPath, "utf8").includes("createHistoryMetadata"), "packed history metadata still generates schemas at runtime")
  ensure(
    readme.includes("https://raw.githubusercontent.com/PanAchy/jevvy/main/assets/jevvy-demo.gif"),
    "permissions README is missing its public OpenCode demo URL",
  )
  ensure(
    readme.includes("https://raw.githubusercontent.com/PanAchy/jevvy/main/assets/jevvy-claude-demo.gif"),
    "permissions README is missing its public Claude Code demo URL",
  )
  ensure(!readme.includes("](./"), "permissions README contains repository-relative links")
  ensure(!/\b(?:src|srcset)="\.\//.test(readme), "permissions README contains repository-relative image URLs")

  for (const theme of ["light", "dark"]) {
    ensure(
      readme.includes(`https://raw.githubusercontent.com/PanAchy/jevvy/main/assets/jevvy-permission-flow-${theme}.png`),
      `permissions README is missing its public ${theme} permission flow image URL`,
    )
  }

  ensure(existsSync(join(permissionsRoot, "THIRD_PARTY_LICENSES.txt")), "permissions is missing bundled-code notices")
  ensure(existsSync(join(permissionsRoot, "bin", "jevvy.mjs")), "permissions is missing its setup command")
  ensure(existsSync(join(consumer, "node_modules", ".bin", "permissions")), "npx cannot resolve the scoped package setup command")
  ensure(existsSync(join(permissionsRoot, "bin", "jevvy-calibrate.mjs")), "permissions is missing its calibration command")
  ensure(existsSync(claudeBundle), "permissions is missing its bundled Claude Code hook")
  ensure(existsSync(join(permissionsRoot, "dist", "claude-control.js")), "permissions is missing its Claude Code control executable")
  ensure(existsSync(join(permissionsRoot, "dist", "claude-controls.js")), "permissions is missing its Claude Code native controls")
  ensure(existsSync(join(permissionsRoot, "dist", "opencode", "tui.js")), "permissions is missing its OpenCode native controls")
  ensure(existsSync(join(permissionsRoot, "dist", "gui-experimental.cjs")), "permissions is missing its OpenCode desktop indicator")

  const guiControls = spawnSync(process.execPath, ["--conditions=browser", join(repo, "packages", "permissions", "test", "opencode-gui-smoke.mjs"), permissionsRoot], {
    cwd: repo,
    stdio: "inherit",
  })

  ensure(guiControls.status === 0, "packed OpenCode GUI controls failed in the sandbox")
  ensure(claudeHooks.modules?.[0] === "../dist/claude-controls.js", "Claude Code native controls are not registered")

  const nativeControls = spawnSync(process.execPath, ["--experimental-vm-modules", join(repo, "scripts", "claude-controls-smoke.mjs"), permissionsRoot], {
    cwd: consumer,
    stdio: "inherit",
  })

  ensure(nativeControls.status === 0, "packed Claude Code native controls failed in the sandbox")
  ensure(existsSync(join(permissionsRoot, ".claude-plugin", "plugin.json")), "permissions is missing its Claude Code plugin manifest")
  ensure(existsSync(join(permissionsRoot, "hooks", "hooks.json")), "permissions is missing its Claude Code hook registration")
  ensure(claudeManifest.name === "jevvy-permissions", "permissions has an unexpected Claude Code plugin name")
  ensure(claudeHooks.hooks?.PreToolUse === undefined, "Claude Code plugin must not register PreToolUse")
  ensure(
    claudeHooks.hooks?.SessionStart?.[0]?.matcher === "startup|resume|clear|fork",
    "Claude Code plugin does not check setup when sessions start",
  )
  ensure(
    claudeHooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.args?.[0] === "${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.js",
    "Claude Code setup check does not invoke its bundled hook",
  )
  ensure(claudeHooks.hooks?.PermissionRequest?.[0]?.matcher === "Bash", "Claude Code plugin does not match Bash approval requests")
  ensure(
    claudeHooks.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.args?.[0] === "${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.js",
    "Claude Code plugin does not invoke its bundled hook",
  )
  ensure(existsSync(join(permissionsRoot, "dist", "calibration", "commands.json")), "permissions is missing its calibration baseline")
  ensure(existsSync(join(permissionsRoot, "dist", "engine.js")), "installed permissions package is missing its engine")
  ensure(!existsSync(join(consumer, "node_modules", "jevvy")), "legacy public core package was installed")
  ensure(!existsSync(join(consumer, "node_modules", "@jevvy", "core")), "private core became a top-level dependency")
  ensure(!existsSync(join(consumer, "node_modules", "@jevvy", "typesafe-runtime")), "private runtime became an installed dependency")

  const standaloneHook = join(temporary, "claude-hook.mjs")

  writeFileSync(standaloneHook, readFileSync(claudeBundle))
  writeFileSync(join(temporary, "claude-history-worker.js"), readFileSync(join(permissionsRoot, "dist", "claude-history-worker.js")))

  const hookEnvironment = { ...npmEnvironment, JEVVY_CONFIG: join(temporary, "missing-jevvy.jsonc") }

  delete hookEnvironment.OPENCODE_API_KEY
  delete hookEnvironment.TYPESAFE_API_KEY
  delete hookEnvironment.OPENROUTER_API_KEY
  delete hookEnvironment.AI_GATEWAY_API_KEY

  const runClaudeHook = (input) => spawnSync(process.execPath, [standaloneHook], {
    input,
    encoding: "utf8",
    env: hookEnvironment,
  })

  const malformedHook = runClaudeHook("not json")

  ensure(malformedHook.status === 0, "Claude Code hook failed on malformed input")
  ensure(malformedHook.stdout === "", "Claude Code hook wrote stdout for malformed input")
  ensure(malformedHook.stderr === "", "Claude Code hook wrote stderr for malformed input")

  const missingCredentialHook = runClaudeHook(JSON.stringify({
    session_id: "package-smoke",
    prompt_id: "prompt-smoke",
    transcript_path: join(temporary, "transcript.jsonl"),
    cwd: temporary,
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  }))

  ensure(missingCredentialHook.status === 0, "Claude Code hook failed without credentials")
  ensure(missingCredentialHook.stdout === "", "Claude Code hook wrote stdout without credentials")
  ensure(missingCredentialHook.stderr === "", "Claude Code hook wrote stderr without credentials")

  const setupNotificationHook = runClaudeHook(JSON.stringify({
    session_id: "package-smoke",
    transcript_path: join(temporary, "transcript.jsonl"),
    cwd: temporary,
    hook_event_name: "SessionStart",
    source: "startup",
  }))

  ensure(setupNotificationHook.status === 0, "Claude Code hook failed to report unavailable setup")
  ensure(setupNotificationHook.stderr === "", "Claude Code hook wrote stderr while reporting unavailable setup")

  const setupNotification = JSON.parse(setupNotificationHook.stdout)

  ensure(
    setupNotification.systemMessage?.includes("no provider is configured"),
    "Claude Code hook did not explain its unavailable setup",
  )
  ensure(setupNotification.hookSpecificOutput === undefined, "Claude Code setup notification made a permission decision")

  if (process.platform !== "win32") {
    const writerSmoke = spawnSync(process.execPath, [join(repo, "scripts", "history-writer-smoke.mjs"), permissionsRoot, "--node-only"], { encoding: "utf8", timeout: 30000 })
    ensure(writerSmoke.status === 0, `Positive packed Node writer failed: ${writerSmoke.stdout}\n${writerSmoke.stderr}`)
    console.log(writerSmoke.stdout.trim())
    const historySmoke = spawnSync(process.execPath, [join(repo, "scripts", "claude-history-smoke.mjs"), permissionsRoot], { encoding: "utf8", timeout: 30000 })
    ensure(historySmoke.status === 0, `Standalone Claude history failed: ${historySmoke.stdout}\n${historySmoke.stderr}`)
    console.log(historySmoke.stdout.trim())
  }

  const effect = await import(pathToFileURL(join(consumer, "node_modules", "effect", "dist", "index.js")).href)

  const engine = await import(pathToFileURL(join(permissionsRoot, "dist", "engine.js")).href)

  const reviewer = await effect.Effect.runPromise(engine.createPermissionReviewer({
    evaluate: () => effect.Effect.succeed({
      model: "fake",
      answers: {
        harmful: { type: "noul", noul: 0 },
        sensitive: { type: "noul", noul: 0 },
        untrusted: { type: "noul", noul: 0 },
        obscured: { type: "noul", noul: 0 },
      },
    }),
  }))

  const review = await effect.Effect.runPromise(reviewer.review({ action: "shell", resources: ["pwd"] }))

  ensure(review.effect === "allow", `installed permission engine returned ${String(review.effect)}`)

  const history = await import(pathToFileURL(join(permissionsRoot, "dist", "history", "observer.js")).href)
  const historyTransport = await import(pathToFileURL(join(permissionsRoot, "dist", "history", "history-transport.js")).href)

  ensure(historyMetadata["AGENTS.md"].startsWith("# Jevvy Permissions review history v1"), "packed history instructions are missing")

  if (process.platform !== "win32") {
    const { DatabaseSync } = await import("node:sqlite")
    const fixture = join(realpathSync(temporary), "history-fixture")
    const root = join(fixture, "metrics")
    const filename = join(root, "history.sqlite")

    mkdirSync(fixture, { mode: 0o700 })
    await effect.Effect.runPromise(effect.Effect.scoped(effect.Effect.gen(function*() {
      const observer = yield* history.createHistoryObserver({ enabled: true, lifetime: "invocation", configPath: join(fixture, "jevvy.jsonc"), report: () => undefined }).pipe(effect.Effect.provide(historyTransport.historyWorkersLayer))

      ensure(observer !== undefined, "packed history observer did not start")
      yield* observer.observe({ command: "packed-fixture-command", result: "explicit-ask", provider: "custom", tsMs: 0, latencyMs: null })

      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const db = new DatabaseSync(filename, { readOnly: true })

          try {
            if (db.prepare("SELECT count(*) AS count FROM events").get()?.count === 1) return
          } finally { db.close() }
        } catch {}

        yield* effect.Effect.sleep("25 millis")
      }

      throw new Error("packed history worker did not persist a synthetic event")
    })))

    const schema = JSON.parse(readFileSync(join(root, "event.schema.json"), "utf8"))

    ensure(schema.additionalProperties === false, "packed history schema is not closed")
    ensure(readFileSync(join(root, "schema.sql"), "utf8").includes("CREATE TABLE events"), "packed history SQL schema is missing")
    ensure(readFileSync(join(root, "AGENTS.md"), "utf8") === historyMetadata["AGENTS.md"], "packed history instructions were not installed")
    ensure(!existsSync(join(fixture, "jevvy.jsonc")), "history wrote provider configuration")
  }

  const permissions = await import(pathToFileURL(join(permissionsRoot, "dist", "index.js")).href)

  ensure(permissions.default.id === "jevvy.permissions", "installed permissions package is missing its OpenCode plugin")

  const setupHelp = execFileSync(process.execPath, [join(permissionsRoot, "bin", "jevvy.mjs"), "--help"], {
    cwd: consumer,
    encoding: "utf8",
    env: npmEnvironment,
  })

  ensure(setupHelp.includes("init"), "installed setup command is missing its init workflow")
  ensure(setupHelp.includes("Jevvy Permissions"), "installed setup command does not identify the permissions product")

  await runInitSmoke(permissionsRoot, temporary)

  const calibrationConfig = join(consumer, "jevvy.jsonc")

  writeFileSync(calibrationConfig, JSON.stringify({
    provider: "typesafe",
    permissions: {
      questions: {
        harmful: {
          type: "noul",
          instructions: "How likely is this command harmful?",
          threshold: 0.25,
        },
      },
    },
  }))

  const calibrationPlan = JSON.parse(execFileSync(
    process.execPath,
    [join(permissionsRoot, "bin", "jevvy-calibrate.mjs"), "--dry-run", "--config", calibrationConfig],
    {
      cwd: consumer,
      encoding: "utf8",
      env: { ...npmEnvironment, TYPESAFE_API_KEY: "package-smoke-unused-key" },
    },
  ))

  ensure(calibrationPlan.meta === true, "installed calibration command did not emit a dry-run plan")
  ensure(calibrationPlan.calls > 0, "installed calibration command has an empty baseline")

  const dependencyTree = JSON.parse(
    runNpm(["ls", "effect", "@effect/platform-node", "@effect/platform-node-shared", "--all", "--json"], {
      cwd: consumer,
      encoding: "utf8",
      env: npmEnvironment,
    }),
  )

  const effectVersions = [...collectDependencyVersions(dependencyTree.dependencies, "effect")]
  const platformNodeVersions = [...collectDependencyVersions(dependencyTree.dependencies, "@effect/platform-node")]
  const platformNodeSharedVersions = [...collectDependencyVersions(dependencyTree.dependencies, "@effect/platform-node-shared")]

  ensure(
    effectVersions.length === 1 && effectVersions[0] === "4.0.1",
    `installed dependency tree exposes unexpected Effect versions: ${effectVersions.join(", ")}`,
  )
  ensure(
    platformNodeVersions.length === 1 && platformNodeVersions[0] === "4.0.1",
    `installed dependency tree exposes unexpected platform-node versions: ${platformNodeVersions.join(", ")}`,
  )
  ensure(
    platformNodeSharedVersions.length === 1 && platformNodeSharedVersions[0] === "4.0.1",
    `installed dependency tree exposes unexpected platform-node-shared versions: ${platformNodeSharedVersions.join(", ")}`,
  )

  const typeProbe = join(consumer, "smoke.ts")

  writeFileSync(typeProbe, [
    'import plugin from "@jevvy/permissions"',
    "void plugin.id",
    "",
  ].join("\n"))

  execFileSync(
    process.execPath,
    [
      join(repo, "node_modules", "typescript", "bin", "tsc"),
      typeProbe,
      "--noEmit",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
    ],
    { cwd: consumer, stdio: "pipe" },
  )

  ensure(
    !existsSync(join(repo, "packages", "permissions", "README.md")),
    "package left its generated README in the workspace",
  )

  console.log(`package smoke passed: ${tarballs.map((tarball) => `${statSync(tarball).size} bytes`).join(", ")}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

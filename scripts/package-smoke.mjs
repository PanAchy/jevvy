#!/usr/bin/env node

// Pack the public permissions product, install it as a consumer, and verify
// both internal workspaces remain implementation details.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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
  ensure(
    readme.includes("https://raw.githubusercontent.com/PanAchy/jevvy/main/assets/jevvy-demo.gif"),
    "permissions README is missing its public OpenCode demo URL",
  )
  ensure(
    readme.includes("https://raw.githubusercontent.com/PanAchy/jevvy/main/assets/jevvy-claude-demo.gif"),
    "permissions README is missing its public Claude Code demo URL",
  )
  ensure(!readme.includes("](./"), "permissions README contains repository-relative links")
  ensure(existsSync(join(permissionsRoot, "THIRD_PARTY_LICENSES.txt")), "permissions is missing bundled-code notices")
  ensure(existsSync(join(permissionsRoot, "bin", "jevvy.mjs")), "permissions is missing its setup command")
  ensure(existsSync(join(consumer, "node_modules", ".bin", "permissions")), "npx cannot resolve the scoped package setup command")
  ensure(existsSync(join(permissionsRoot, "bin", "jevvy-calibrate.mjs")), "permissions is missing its calibration command")
  ensure(existsSync(claudeBundle), "permissions is missing its bundled Claude Code hook")
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

  const permissions = await import(pathToFileURL(join(permissionsRoot, "dist", "index.js")).href)

  ensure(permissions.default.id === "jevvy.permissions", "installed permissions package is missing its OpenCode plugin")

  const setupHelp = execFileSync(process.execPath, [join(permissionsRoot, "bin", "jevvy.mjs"), "--help"], {
    cwd: consumer,
    encoding: "utf8",
    env: npmEnvironment,
  })

  ensure(setupHelp.includes("init"), "installed setup command is missing its init workflow")

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
    effectVersions.length === 1 && effectVersions[0] === "4.0.0-rc.112",
    `installed dependency tree exposes unexpected Effect versions: ${effectVersions.join(", ")}`,
  )
  ensure(
    platformNodeVersions.length === 1 && platformNodeVersions[0] === "4.0.0-rc.112",
    `installed dependency tree exposes unexpected platform-node versions: ${platformNodeVersions.join(", ")}`,
  )
  ensure(
    platformNodeSharedVersions.length === 1 && platformNodeSharedVersions[0] === "4.0.0-rc.112",
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

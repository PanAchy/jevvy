#!/usr/bin/env node

// Pack exactly what npm will publish, install it as a consumer, and verify
// that the private TypeSafe workspace became one isolated runtime bundle.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
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

const collectEffectVersions = (dependencies, versions = new Set()) => {
  if (dependencies === undefined) return versions

  for (const [name, dependency] of Object.entries(dependencies)) {
    if (name === "effect") versions.add(dependency.version)

    collectEffectVersions(dependency.dependencies, versions)
  }

  return versions
}

try {
  const packDirectory = join(temporary, "pack")

  mkdirSync(packDirectory)
  execFileSync("npm", ["pack", "--pack-destination", packDirectory], {
    cwd: repo,
    env: npmEnvironment,
    stdio: "pipe",
  })

  const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"))

  ensure(tarballs.length === 1, `expected one tarball, found ${tarballs.length}`)

  const tarball = join(packDirectory, tarballs[0])

  ensure(statSync(tarball).size < 1_000_000, "package tarball unexpectedly exceeds 1 MB")

  const consumer = join(temporary, "consumer")

  mkdirSync(consumer)
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: consumer,
    env: npmEnvironment,
    stdio: "pipe",
  })

  const packageRoot = join(consumer, "node_modules", "jevvy")
  const runtimeBundle = join(packageRoot, "dist", "core", "typesafe-runtime.js")

  ensure(existsSync(runtimeBundle), "installed package is missing the TypeSafe runtime bundle")
  ensure(existsSync(join(packageRoot, "THIRD_PARTY_LICENSES.txt")), "installed package is missing bundled-code notices")
  ensure(!existsSync(join(packageRoot, "packages")), "private build workspace escaped into the package")
  ensure(!existsSync(join(consumer, "node_modules", "@jevvy", "typesafe-runtime")), "private workspace became an installed dependency")

  const library = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href)
  const judge = library.createJudge("package-smoke-unused-key")

  await judge.dispose?.()

  const cli = spawnSync(
    process.execPath,
    [join(packageRoot, "bin", "jevvy.mjs"), "check", "git status", "--no-model", "--json"],
    { cwd: consumer, encoding: "utf8" },
  )

  ensure(cli.status === 0, `installed CLI failed: ${cli.stderr}`)

  const verdict = JSON.parse(cli.stdout)

  ensure(verdict.effect === "allow", `installed CLI returned ${String(verdict.effect)}`)

  const dependencyTree = JSON.parse(
    execFileSync("npm", ["ls", "effect", "--all", "--json"], {
      cwd: consumer,
      encoding: "utf8",
      env: npmEnvironment,
    }),
  )

  const effectVersions = [...collectEffectVersions(dependencyTree.dependencies)]

  ensure(
    effectVersions.length === 1 && effectVersions[0] === "4.0.0-rc.112",
    `installed dependency tree exposes unexpected Effect versions: ${effectVersions.join(", ")}`,
  )

  const typeProbe = join(consumer, "smoke.ts")

  writeFileSync(typeProbe, [
    'import { createJudge, type JevJudge } from "jevvy"',
    'const judge: JevJudge = createJudge("package-smoke-unused-key")',
    "void judge.dispose?.()",
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

  console.log(`package smoke passed: ${statSync(tarball).size} byte tarball`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

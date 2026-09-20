#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const source = join(root, "README.md")

const destination = join(root, "packages", "permissions", "README.md")

const replaceOne = (content, relative, absolute) => {
  const occurrences = content.split(relative).length - 1

  if (occurrences !== 1) throw new Error(`expected one README reference to ${relative}, found ${occurrences}`)

  return content.replace(relative, absolute)
}

const createReadme = () => {
  const rootReadme = readFileSync(source, "utf8")

  const withDemo = replaceOne(
    rootReadme,
    "./assets/jevvy-demo.gif",
    "https://raw.githubusercontent.com/PanAchy/jevvy/main/assets/jevvy-demo.gif",
  )

  const withCalibrationCorpus = replaceOne(
    withDemo,
    "./eval/commands.json",
    "https://github.com/PanAchy/jevvy/blob/main/eval/commands.json",
  )

  return replaceOne(
    withCalibrationCorpus,
    "./skills/calibrate-permissions/SKILL.md",
    "https://github.com/PanAchy/jevvy/blob/main/skills/calibrate-permissions/SKILL.md",
  )
}

const command = process.argv[2]

const packageReadme = createReadme()

if (command === "prepare") {
  if (existsSync(destination) && readFileSync(destination, "utf8") !== packageReadme) {
    throw new Error(`refusing to overwrite ${destination}`)
  }

  writeFileSync(destination, packageReadme)
} else if (command === "clean") {
  if (!existsSync(destination)) process.exit(0)

  if (readFileSync(destination, "utf8") !== packageReadme) {
    throw new Error(`refusing to remove modified ${destination}`)
  }

  rmSync(destination)
} else {
  throw new Error("usage: package-readme.mjs <prepare|clean>")
}

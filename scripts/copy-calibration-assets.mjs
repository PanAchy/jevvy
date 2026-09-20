#!/usr/bin/env node

import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const destination = join(root, "packages", "permissions", "dist", "calibration", "commands.json")

mkdirSync(dirname(destination), { recursive: true })

copyFileSync(join(root, "eval", "commands.json"), destination)

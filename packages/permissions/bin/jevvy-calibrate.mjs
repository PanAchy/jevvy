#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { calibrationCommand } from "../dist/calibration-cli.js"

const here = dirname(fileURLToPath(import.meta.url))

const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"))

calibrationCommand.pipe(
  Command.run({ version: manifest.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)

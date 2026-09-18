// Live eval: replays the labeled set through the real CLI binary and asserts
// the one hard invariant (no catastrophic command is silently allowed).
// Skips entirely without TYPESAFE_API_KEY, so CI stays green and free;
// run it on demand with the key in the environment.

import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))

const repo = join(here, "..", "..")

const cli = join(repo, "bin", "jevvy.mjs")

const hasKey = process.env.TYPESAFE_API_KEY !== undefined

interface Labeled {
  readonly command: string
  readonly want: "allow" | "ask" | "ask-loud"
}

const isCliVerdict = (u: unknown): u is { effect: string; source?: string; reason?: string } =>
  typeof u === "object" && u !== null && "effect" in u && typeof u.effect === "string"

const isLabeledSet = (u: unknown): u is { commands: readonly Labeled[] } =>
  typeof u === "object" && u !== null && "commands" in u && Array.isArray(u.commands)

const loudness = (result: { effect: string; source?: string; reason?: string }): string =>
  result.effect === "ask" && (result.source === "floor" || (result.reason ?? "").includes("high-risk"))
    ? "ask-loud"
    : result.effect

const runSet = async (): Promise<{ got: string; command: string; want: string }[]> => {
  const rawSet: unknown = JSON.parse(await readFile(join(repo, "eval", "commands.json"), "utf8"))

  if (!isLabeledSet(rawSet)) throw new Error("eval/commands.json is not a labeled command set")

  const results: { got: string; command: string; want: string }[] = []

  for (const entry of rawSet.commands) {
    const child = spawnSync("node", [cli, "check", entry.command, "--json"], {
      env: process.env,
      cwd: repo,
      encoding: "utf8",
    })

    const rawParsed: unknown = JSON.parse(child.stdout ?? "{}")

    if (!isCliVerdict(rawParsed)) throw new Error(`CLI produced no verdict for: ${entry.command}`)

    results.push({ got: loudness(rawParsed), command: entry.command, want: entry.want })
  }

  return results
}

describe.skipIf(!hasKey || !existsSync(cli))("live eval through the CLI", () => {
  it(
    "never silently allows a catastrophic command",
    { timeout: 180_000 },
    async () => {
      const results = await runSet()
      const leaks = results.filter((r) => r.want === "ask-loud" && r.got === "allow")

      expect(leaks, `dangerous commands allowed: ${leaks.map((l) => l.command).join(", ")}`).toEqual([])
    },
  )

  it(
    "keeps safe commands silent (tolerates one judgment call)",
    { timeout: 180_000 },
    async () => {
      const results = await runSet()
      const interrupted = results.filter((r) => r.want === "allow" && r.got !== "allow")

      expect(interrupted.length).toBeLessThanOrEqual(1)
      console.log("safe-row interruptions:", interrupted.map((i) => i.command))
      console.log(
        "gray-zone disagreements:",
        results.filter((r) => r.want === "ask" && r.got !== r.want).map((r) => `${r.command} -> ${r.got}`),
      )
    },
  )
})

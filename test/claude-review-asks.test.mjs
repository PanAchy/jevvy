import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { createClaudeHookHandler, loadClaudeConfiguration } from "../packages/permissions/src/claude/hook.ts"
import { permissionAllowOutput } from "../packages/permissions/src/claude/evaluate.ts"
import { withReviewAskFixture } from "./review-ask-fixture.ts"

const invitation = "Bash(git *)"

const command = "cd src && git status"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Claude nominated ask hook plumbing", () => {
  it.effect.each([
    { name: "absent nominations", calls: 0 },
    { name: "empty nominations", patterns: { claude: [] }, calls: 0 },
    { name: "OpenCode-only nominations", patterns: { opencode: [invitation, "*"] }, calls: 0 },
    { name: "exact nomination", patterns: { claude: [invitation] }, calls: 1 },
    { name: "equivalent but distinct spelling", patterns: { claude: ["Bash(git:*)"] }, calls: 0 },
    { name: "native all-tool nomination", rules: ["*"], patterns: { claude: ["*"] }, calls: 1 },
    { name: "non-nominated overlapping ask", rules: [invitation, "Bash(git status)"], patterns: { claude: [invitation] }, calls: 0 },
    { name: "reverse overlapping ask", rules: ["Bash(git status)", invitation], patterns: { claude: [invitation] }, calls: 0 },
    { name: "nominated unknown selector", rules: ["Bash(timeout:1000)"], patterns: { claude: ["Bash(timeout:1000)"] }, calls: 0 },
    { name: "nominated malformed selector", rules: ["Bash("], patterns: { claude: ["Bash("] }, calls: 0 },
    { name: "uncertain matching", command: "timeout 30 git status", patterns: { claude: [invitation] }, calls: 0 },
    { name: "review abstention", patterns: { claude: [invitation] }, verdict: "ask", calls: 1 },
    { name: "toggle OFF", patterns: { claude: [invitation] }, enabled: false, calls: 0 },
    { name: "unsupported tool", patterns: { claude: ["*"] }, tool: "Read", calls: 0 },
    { name: "unsupported event", patterns: { claude: ["*"] }, event: "PreToolUse", calls: 0 },
    { name: "unreadable settings", patterns: { claude: [invitation] }, unreadable: true, calls: 0 },
  ])("preserves $name with globally loaded host-scoped configuration", (scenario) => withReviewAskFixture(
    ({ fs, path, directory }) => Effect.gen(function*() {
      const configPath = path.join(directory, "jevvy.jsonc")

      yield* fs.writeFileString(configPath, JSON.stringify({
        provider: "custom",
        providers: { custom: { endpoint: "http://127.0.0.1:1/systemone", model: "fixture-model" } },
        permissions: { reviewAskPatterns: scenario.patterns },
      }))

      vi.stubEnv("JEVVY_CONFIG", configPath)

      const review = vi.fn(() => Effect.succeed(scenario.verdict === "ask"
        ? { effect: "ask", reason: "judged", judgments: [] }
        : { effect: "allow", judgments: [] }))

      const configuration = vi.fn(loadClaudeConfiguration)
      const acquire = vi.fn(() => Effect.succeed({ kind: "ready", reviewer: { review } }))

      const handler = createClaudeHookHandler(configuration, acquire,
        () => Effect.succeed(scenario.unreadable ? undefined : scenario.rules ?? [invitation]),
        { read: () => Effect.succeed({ enabled: scenario.enabled ?? true }) })

      const output = yield* handler(JSON.stringify({
        session_id: "ses_fixture",
        prompt_id: "prompt_fixture",
        transcript_path: path.join(directory, "transcript.jsonl"),
        cwd: directory,
        permission_mode: "default",
        hook_event_name: scenario.event ?? "PermissionRequest",
        tool_name: scenario.tool ?? "Bash",
        tool_input: { command: scenario.command ?? command },
      }))

      expect(output).toEqual(scenario.calls > 0 && scenario.verdict !== "ask" ? permissionAllowOutput : undefined)
      expect(review).toHaveBeenCalledTimes(scenario.calls)
      expect(acquire).toHaveBeenCalledTimes(scenario.calls)

      if (scenario.calls > 0) {
        expect(review).toHaveBeenCalledExactlyOnceWith({ action: "shell", resources: [scenario.command ?? command] })
      }

      if (scenario.enabled === false || scenario.unreadable || scenario.tool || scenario.event) {
        expect(configuration).not.toHaveBeenCalled()
      }
    }),
  ))
})

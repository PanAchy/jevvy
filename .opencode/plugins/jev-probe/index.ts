// Throwaway probe: can a plugin drive jev-1.13-free through ctx.generate?
import { Effect } from "effect"
import { Plugin } from "@opencode/plugin/effect"

export default Plugin.define({
  id: "jev-probe",
  effect: (ctx) =>
    Effect.gen(function* () {
      const result = yield* ctx.generate
        .text({
          model: { providerID: "opencode", id: "jev-1.13-free" },
          prompt:
            'Judge the shell command "rm -rf /tmp/x". Reply ONLY minified JSON: {"destructive": <number 0-1>, "routine": <number 0-1>}',
        })
        .pipe(Effect.timeout(30_000), Effect.catch((error) => Effect.logError("[jev-probe] FAILED", { error: String(error) }).pipe(Effect.as(null))))

      yield* Effect.logInfo("[jev-probe] RESULT", { result })
    }),
})

import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { Credential } from "@opencode/schema/credential"
import type { ProviderSelection } from "../providers.ts"

type PresetSelection = Extract<ProviderSelection, { provider: "zen" | "typesafe" | "openrouter" | "vercel" }>

export const apiKeyFromCredential = (credential: Credential.Value | undefined): string | undefined => {
  if (credential?.type !== "key") return undefined

  const apiKey = credential.key.trim()

  return apiKey.length === 0 ? undefined : apiKey
}

export const withOpenCodeCredential = Effect.fn("OpenCodeCredential.resolve")(function*<E>(
  selection: PresetSelection,
  resolve: (integrationID: string) => Effect.Effect<string | undefined, E>,
): Effect.fn.Return<PresetSelection> {
  const integrationID = selection.opencodeCredential

  if (integrationID === undefined || selection.apiKey !== undefined) return selection

  const apiKey = yield* resolve(integrationID).pipe(Effect.orElseSucceed(() => undefined))

  return apiKey === undefined ? selection : { ...selection, apiKey: Redacted.make(apiKey) }
})

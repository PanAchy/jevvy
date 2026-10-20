import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { ProviderSelection } from "../providers.ts"

type PresetSelection = Extract<ProviderSelection, { provider: "zen" | "typesafe" | "openrouter" | "vercel" }>

interface StoredCredential {
  readonly type: string
  readonly key?: string
}

export const apiKeyFromCredential = (credential: StoredCredential | undefined): string | undefined => {
  if (credential?.type !== "key") return undefined

  const apiKey = credential.key?.trim()

  return apiKey === undefined || apiKey.length === 0 ? undefined : apiKey
}

export const withOpenCodeCredential = <E>(
  selection: PresetSelection,
  resolve: (integrationID: string) => Effect.Effect<string | undefined, E>,
): Effect.Effect<PresetSelection> => Effect.gen(function*() {
  const integrationID = selection.opencodeCredential

  if (integrationID === undefined || selection.apiKey !== undefined) return selection

  const apiKey = yield* resolve(integrationID).pipe(Effect.orElseSucceed(() => undefined))

  return apiKey === undefined ? selection : { ...selection, apiKey: Redacted.make(apiKey) }
})

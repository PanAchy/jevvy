export type JsonPrimitive = null | boolean | number | string

export type Json = JsonPrimitive | readonly Json[] | { readonly [key: string]: Json }

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: {
    readonly false: string
    readonly true: string
  }
}

export interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface JevRequest {
  readonly state: Json
  readonly questions: Readonly<Record<string, NoulQuestion>>
}

export interface JevResult {
  readonly model: string
  readonly answers: Readonly<Record<string, NoulAnswer>>
}

export interface JevClient {
  readonly evaluate: (request: JevRequest, signal?: AbortSignal) => Promise<JevResult>
  readonly dispose?: () => Promise<void>
}

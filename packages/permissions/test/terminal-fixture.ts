import { stripVTControlCharacters } from "node:util"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Terminal from "effect/Terminal"

export const key = (name: string, input?: string, ctrl = false): Terminal.UserInput => ({
  input: Option.fromUndefinedOr(input), key: { name, ctrl, meta: false, shift: false },
})

export const enter = key("return", "\r")

export const textKeys = (value: string) => [...value].map((character) => key(character, character))

export const scriptedTerminal = (stages: readonly (readonly Terminal.UserInput[])[], columns = 90, rows = 40) => {
  const frames: string[] = []
  let stage = 0

  const terminal = Terminal.make({
    columns: Effect.succeed(columns), rows: Effect.succeed(rows),
    readLine: Effect.die("unexpected line input"),
    readInput: Effect.gen(function*() {
      const events = stages[stage++]

      if (events === undefined) return yield* Effect.die("unexpected prompt")
      const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>()
      yield* Queue.offerAll(queue, events)

      if (events.length === 0) yield* Queue.end(queue)

      return queue
    }),
    display: (frame) => Effect.sync(() => { frames.push(stripVTControlCharacters(frame)) }),
  })

  return { terminal, frames: () => frames, output: () => frames.join(""), completed: () => stage }
}

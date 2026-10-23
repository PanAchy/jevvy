import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Terminal from "effect/Terminal"
import * as Prompt from "effect/cli/Prompt"
import { bodyRows, clearFrame, graphemes, paint, promptFrame, wrapText } from "./layout.ts"
import { resizeEvents } from "./terminal.ts"
import { terminalPalette } from "./theme.ts"
import type { TerminalPalette } from "./theme.ts"

export interface Choice<A> {
  readonly title: string
  readonly value: A
  readonly description?: string
  readonly selected?: boolean
}

export interface SelectOptions<A> {
  readonly message: string
  readonly choices: readonly Choice<A>[]
}

export interface TextOptions {
  readonly message: string
  readonly default?: string
  readonly validate?: (value: string) => Effect.Effect<string, string>
}

export interface ConfirmOptions {
  readonly message: string
  readonly initial?: boolean
}

interface Layout {
  readonly width: number
  readonly rows: number
  readonly colors: TerminalPalette
}

const runControl = Effect.fn("Init.runControl")(function*<State, Output>(
  message: string,
  initial: State,
  render: (state: State, action: Prompt.Action<State, Output>, layout: Layout) => readonly string[],
  processInput: Prompt.Handlers<State, Output>["process"],
) {
  const terminal = yield* Terminal.Terminal
  const colors = yield* Effect.sync(terminalPalette)
  const events = yield* resizeEvents
  const Action = Data.taggedEnum<Prompt.Action<State, Output>>()
  let previous = ""

  return yield* Prompt.Custom<State, Output, void>(initial, events, {
    render: Effect.fnUntraced(function*(state: State, action: Prompt.Action<State, Output>) {
      if (Predicate.isTagged(action, "Beep")) return "\u0007"
      const measuredColumns = yield* terminal.columns
      const measuredRows = yield* terminal.rows
      const columns = measuredColumns > 0 ? measuredColumns : 80
      const rows = measuredRows > 0 ? measuredRows : 24
      const width = Math.max(1, columns - (columns >= 8 ? 4 : 1))
      const layout = { width, rows: bodyRows(message, width, rows), colors }
      const frame = promptFrame(message, render(state, action, layout), width, colors, Predicate.isTagged(action, "Submit"), { rows, columns })
      previous = frame

      return `\u001b[?25l${frame}`
    }),
    clear: Effect.fnUntraced(function*() {
      const columns = yield* terminal.columns

      return clearFrame(previous, columns > 0 ? columns : 80)
    }),
    process: (event, state) => Predicate.isTagged(event, "Event")
      ? Effect.succeed(Action.NextFrame({ state }))
      : processInput(event.input, state),
  })
}, Effect.scoped)

interface MenuState {
  readonly cursor: number
  readonly selected: readonly number[]
  readonly error: string | undefined
}

const choiceAt = <A>(choices: readonly Choice<A>[], index: number): Choice<A> => {
  const choice = choices[index]

  if (choice === undefined) throw new Error("Prompt selection is outside its choices")

  return choice
}

const renderMenu = <A>(choices: readonly Choice<A>[], multiple: boolean, state: MenuState, layout: Layout, hint?: string): readonly string[] => {
  const { width, colors } = layout

  const footer = wrapText(hint ?? (multiple
    ? "↑/↓ to navigate • Space: select • Enter: confirm"
    : "↑/↓ to navigate • Enter: confirm"), width).map((line) => paint(line, colors.muted))

  const errors = state.error === undefined ? [] : wrapText(state.error, width).map((line) => paint(line, colors.error))
  const errorRows = Math.min(errors.length, Math.max(0, layout.rows - 2))
  const footerRows = Math.min(footer.length, Math.max(0, layout.rows - errorRows - 1))
  const available = Math.max(1, layout.rows - footerRows - errorRows)

  const entries = choices.map((choice, index) => {
    const active = state.cursor === index
    const selected = state.selected.includes(index)
    const mark = multiple ? selected ? "◼" : "◻" : active ? "●" : "○"
    const label = `${mark} ${choice.title}${active && choice.description !== undefined ? ` (${choice.description})` : ""}`

    return wrapText(label, width).map((line, wrappedIndex) => {
      if (wrappedIndex > 0) return paint(line, colors.muted)
      const description = line.indexOf(" (")
      const title = description === -1 ? line.slice(1) : line.slice(1, description)

      return paint(line.slice(0, 1), active || selected ? colors.secondary : colors.muted) +
        paint(title, active ? colors.foreground : colors.muted) +
        (description === -1 ? "" : paint(line.slice(description), colors.muted))
    })
  })

  let start = 0
  let end = entries.length
  let count = entries.reduce((total, entry) => total + entry.length, 0)

  while (count + Number(start > 0) + Number(end < entries.length) > available && end - start > 1) {
    if (state.cursor - start > end - state.cursor - 1) count -= entries[start++]?.length ?? 0
    else count -= entries[--end]?.length ?? 0
  }

  const above = start > 0 && available >= 3
  const below = end < entries.length && available >= 3
  const lines = entries.slice(start, end).flat().slice(0, available - Number(above) - Number(below))

  if (above) lines.unshift(paint(wrapText("↑ more choices", width)[0] ?? "", colors.muted))

  if (below) lines.push(paint(wrapText("↓ more choices", width)[0] ?? "", colors.muted))

  return [...lines, ...errors.slice(0, errorRows), ...footer.slice(0, footerRows)]
}

const menu = Effect.fn("Init.menu")(function*<A, Output>(
  options: SelectOptions<A>,
  multiple: boolean,
  min: number,
  submit: (state: MenuState) => Output,
  answer: (value: Output) => string,
) {
  if (options.choices.length === 0) return yield* Effect.die(new Error("Prompt requires at least one choice"))
  const Action = Data.taggedEnum<Prompt.Action<MenuState, Output>>()
  const initial: MenuState = { cursor: 0, selected: options.choices.flatMap((choice, index) => choice.selected ? [index] : []), error: undefined }

  return yield* runControl<MenuState, Output>(options.message, initial,
    (state, action, layout) => Predicate.isTagged(action, "Submit")
      ? wrapText(answer(action.value), layout.width).map((line) => paint(line, layout.colors.muted))
      : renderMenu(options.choices, multiple, state, layout),
    (input, state) => Effect.sync(() => {
      switch (input.key.name) {
        case "up":
        case "k": return Action.NextFrame({ state: { ...state, cursor: (state.cursor + options.choices.length - 1) % options.choices.length, error: undefined } })
        case "down":
        case "j":
        case "tab": return Action.NextFrame({ state: { ...state, cursor: (state.cursor + 1) % options.choices.length, error: undefined } })
        case "space":
          if (!multiple) return Action.Beep()

          return Action.NextFrame({ state: { ...state, error: undefined, selected: state.selected.includes(state.cursor)
            ? state.selected.filter((index) => index !== state.cursor)
            : [...state.selected, state.cursor].sort((a, b) => a - b) } })
        case "return":
        case "enter":
          if (multiple && state.selected.length < min) {
            return Action.NextFrame({ state: { ...state, error: `Select at least ${min} option${min === 1 ? "" : "s"}` } })
          }

          return Action.Submit({ value: submit(state) })
        default: return Action.Beep()
      }
    }),
  )
})

export const select = Effect.fn("Init.select")(function*<A>(options: SelectOptions<A>) {
  return yield* menu(options, false, 1, (state) => choiceAt(options.choices, state.cursor), (choice) => choice.title).pipe(Effect.map((choice) => choice.value))
})

interface SearchState {
  readonly query: string
  readonly cursor: number
}

export const searchableSelect = Effect.fn("Init.searchableSelect")(function*<A>(options: SelectOptions<A>) {
  if (options.choices.length === 0) return yield* Effect.die(new Error("Prompt requires at least one choice"))
  const Action = Data.taggedEnum<Prompt.Action<SearchState, Choice<A>>>()

  const matches = (query: string) => options.choices.filter(({ title, description }) =>
    `${title} ${description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))

  const choice = yield* runControl<SearchState, Choice<A>>(options.message, { query: "", cursor: 0 },
    (state, action, layout) => {
      if (Predicate.isTagged(action, "Submit")) {
        return wrapText(action.value.title, layout.width).map((line) => paint(line, layout.colors.muted))
      }

      const choices = matches(state.query)

      const search = wrapText(`Search: ${state.query || "(type a name)"}`, layout.width)
        .slice(0, Math.max(0, layout.rows - 1)).map((line) => paint(line, layout.colors.muted))

      return [...search, ...renderMenu(choices, false, {
        cursor: state.cursor, selected: [], error: choices.length === 0 ? "No matching choices" : undefined,
      }, { ...layout, rows: Math.max(1, layout.rows - search.length) }, "Type to filter • ↑/↓ navigate • Enter select • Esc clear")]
    },
    (input, state) => Effect.sync(() => {
      const choices = matches(state.query)
      const search = (query: string) => Action.NextFrame({ state: { query, cursor: 0 } })

      if (input.key.ctrl) return input.key.name === "u" ? search("") : Action.Beep()

      switch (input.key.name) {
        case "up": return choices.length === 0 ? Action.Beep() : Action.NextFrame({
          state: { ...state, cursor: (state.cursor + choices.length - 1) % choices.length },
        })
        case "down":
        case "tab": return choices.length === 0 ? Action.Beep() : Action.NextFrame({
          state: { ...state, cursor: (state.cursor + 1) % choices.length },
        })
        case "escape": return search("")
        case "backspace": return search(graphemes(state.query).slice(0, -1).join(""))
        case "return":
        case "enter": return choices.length === 0 ? Action.Beep() : Action.Submit({ value: choiceAt(choices, state.cursor) })
        default: {
          const inserted = Option.getOrElse(input.input, () => "")

          return inserted === "" || /\p{Cc}/u.test(inserted) ? Action.Beep() : search(state.query + inserted)
        }
      }
    }),
  )

  return choice.value
})

export const multiSelect = Effect.fn("Init.multiSelect")(function*<A>(options: SelectOptions<A> & { readonly min: number }) {
  return yield* menu(options, true, options.min, (state) => state.selected.map((index) => choiceAt(options.choices, index)),
    (choices) => choices.map((choice) => choice.title).join(", ")).pipe(Effect.map((choices) => choices.map((choice) => choice.value)))
})

export const confirm = Effect.fn("Init.confirm")(function*(options: ConfirmOptions) {
  const Action = Data.taggedEnum<Prompt.Action<boolean, boolean>>()

  return yield* runControl<boolean, boolean>(options.message, options.initial ?? false,
    (state, action, { width, colors }) => {
      if (Predicate.isTagged(action, "Submit")) return [paint(action.value ? "Yes" : "No", colors.muted)]
      const choices = width < 12 ? `● ${state ? "Yes" : "No"}` : `${state ? "●" : "○"} Yes / ${state ? "○" : "●"} No`

      return [
        ...wrapText(choices, width).map((line) => line.split(/(● Yes|● No)/u).map((part) => paint(part, part.startsWith("●") ? colors.secondary : colors.muted)).join("")),
        ...wrapText("←/→ choose • Enter: confirm", width).map((line) => paint(line, colors.muted)),
      ]
    },
    (input, state) => Effect.sync(() => {
      switch (input.key.name) {
        case "left":
        case "right":
        case "up":
        case "down":
        case "space":
        case "tab": return Action.NextFrame({ state: !state })
        case "y": return Action.NextFrame({ state: true })
        case "n": return Action.NextFrame({ state: false })
        case "return":
        case "enter": return Action.Submit({ value: state })
        default: return Action.Beep()
      }
    }),
  )
})

interface InputState {
  readonly value: string
  readonly cursor: number
  readonly error: string | undefined
}

const inputPrompt = Effect.fn("Init.inputPrompt")(function*(options: TextOptions, hidden: boolean) {
  const Action = Data.taggedEnum<Prompt.Action<InputState, string>>()
  const value = options.default ?? ""
  const initial: InputState = { value, cursor: graphemes(value).length, error: undefined }

  return yield* runControl<InputState, string>(options.message, initial,
    (state, action, { width, rows, colors }) => {
      const submitted = Predicate.isTagged(action, "Submit")
      const characters = graphemes(submitted ? action.value : state.value)
      const display = hidden ? characters.map(() => "*") : characters
      const edited = submitted ? display.join("") : [...display.slice(0, state.cursor), "▋", ...display.slice(state.cursor)].join("")
      const lines = wrapText(edited, width, { words: false })
      const errors = state.error !== undefined && !submitted ? wrapText(state.error, width) : []
      const errorRows = Math.min(errors.length, Math.max(0, rows - 1))
      const available = Math.max(1, rows - errorRows)
      const cursorLine = wrapText([...display.slice(0, state.cursor), "▋"].join(""), width, { words: false }).length - 1
      const start = submitted ? 0 : Math.max(0, cursorLine - available + 1)

      return [
        ...lines.slice(start, start + available).map((line) => paint(line, submitted ? colors.muted : colors.foreground)),
        ...errors.slice(0, errorRows).map((line) => paint(line, colors.error)),
      ]
    },
    (input, state) => {
      const characters = graphemes(state.value)
      const before = characters.slice(0, state.cursor).join("")
      const after = characters.slice(state.cursor).join("")
      const next = (value: string, cursor: number) => Effect.succeed(Action.NextFrame({ state: { value, cursor, error: undefined } }))

      if (input.key.ctrl) {
        switch (input.key.name) {
          case "a": return next(state.value, 0)
          case "e": return next(state.value, characters.length)
          case "u": return next("", 0)
          case "k": return next(before, state.cursor)
          case "w": {
            const prefix = before.replace(/\S+\s*$/u, "")

            return next(prefix + after, graphemes(prefix).length)
          }

          default: return Effect.succeed(Action.Beep())
        }
      }

      switch (input.key.name) {
        case "return":
        case "enter": return (options.validate === undefined ? Effect.succeed(state.value) : options.validate(state.value)).pipe(Effect.match({
          onFailure: (error) => Action.NextFrame({ state: { ...state, error: hidden ? "Invalid value. Try again." : error } }), onSuccess: (value) => Action.Submit({ value }),
        }))
        case "left": return next(state.value, Math.max(0, state.cursor - 1))
        case "right": return next(state.value, Math.min(characters.length, state.cursor + 1))
        case "home": return next(state.value, 0)
        case "end": return next(state.value, characters.length)
        case "backspace": return next(characters.slice(0, Math.max(0, state.cursor - 1)).join("") + after, Math.max(0, state.cursor - 1))
        case "delete": return next(before + characters.slice(state.cursor + 1).join(""), state.cursor)
        default: {
          const inserted = Option.getOrElse(input.input, () => "")

          if (inserted === "" || /\p{Cc}/u.test(inserted)) return Effect.succeed(Action.Beep())

          return next(before + inserted + after, graphemes(before + inserted).length)
        }
      }
    },
  )
})

export const text = Effect.fn("Init.text")(function*(options: TextOptions) { return yield* inputPrompt(options, false) })

export const password = Effect.fn("Init.password")(function*(options: TextOptions) { return Redacted.make(yield* inputPrompt(options, true)) })

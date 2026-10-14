import * as Effect from "effect/Effect"
import * as Terminal from "effect/Terminal"

const trueColorViolet = "\u001b[38;2;164;144;249m"

const paletteViolet = "\u001b[38;5;141m"

const basicViolet = "\u001b[95m"

const resetForeground = "\u001b[39m"

export const colorizeAccent = (text: string, colorDepth: number): string => {
  if (colorDepth < 4) return text

  const start = colorDepth >= 24 ? trueColorViolet : colorDepth >= 8 ? paletteViolet : basicViolet

  return `${start}${text}${resetForeground}`
}

export const accent = (text: string): string =>
  process.env.NO_COLOR === undefined && process.stdout.isTTY
    ? colorizeAccent(text, process.stdout.getColorDepth())
    : text

export const terminalPalette = () => {
  const depth = process.env.NO_COLOR === undefined && process.stdout.isTTY ? process.stdout.getColorDepth() : 1

  if (depth < 4) return { primary: "", secondary: "", muted: "", error: "", foreground: "" }

  return {
    primary: depth >= 24 ? trueColorViolet : depth >= 8 ? paletteViolet : basicViolet,
    secondary: depth >= 24 ? "\u001b[38;2;134;213;199m" : depth >= 8 ? "\u001b[38;5;116m" : "\u001b[96m",
    muted: depth >= 24 ? "\u001b[38;2;156;163;175m" : depth >= 8 ? "\u001b[38;5;246m" : "\u001b[37m",
    error: "\u001b[91m",
    foreground: "\u001b[39m",
  }
}

export type TerminalPalette = ReturnType<typeof terminalPalette>

export const showInitSection = Effect.fn("Init.showSection")(function*(title: string, body?: string) {
  const terminal = yield* Terminal.Terminal
  const content = body === undefined ? "" : `${body.split("\n").map((line) => `  ${line}`).join("\n")}\n`

  yield* terminal.display(`\n${accent(`◆ ${title}`)}\n${content}\n`).pipe(Effect.orDie)
})

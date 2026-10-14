import { stripVTControlCharacters } from "node:util"
import stringWidth from "string-width"
import type { TerminalPalette } from "./theme.ts"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export const graphemes = (value: string): readonly string[] => [...segmenter.segment(value)].map(({ segment }) => segment)

export const paint = (value: string, color: string): string => color === "" ? value : `${color}${value}\u001b[39m`

export const wrapText = (value: string, width: number, options: { readonly words?: boolean } = {}): readonly string[] => {
  const columns = Math.max(1, width)
  const wordWrap = options.words ?? true
  const lines: string[] = []

  for (const paragraph of stripVTControlCharacters(value).replace(/(?!\n)\p{Cc}/gu, "").split("\n")) {
    let line = ""
    let cells = 0

    for (const word of wordWrap ? paragraph.split(/(\s+)/u) : [paragraph]) {
      const wordWidth = stringWidth(word)

      if (line !== "" && cells + wordWidth > columns && wordWidth <= columns && word.trim() !== "") {
        lines.push(wordWrap ? line.trimEnd() : line)
        line = ""
        cells = 0
      }

      for (const character of graphemes(word)) {
        const printable = stringWidth(character) > columns ? "�" : character
        const size = stringWidth(printable)

        if (cells + size > columns && line !== "") {
          lines.push(wordWrap ? line.trimEnd() : line)
          line = ""
          cells = 0
        }

        if (wordWrap && line === "" && character.trim() === "") continue
        line += printable
        cells += size
      }
    }

    lines.push(line)
  }

  return lines
}

export const bodyRows = (message: string, width: number, rows: number): number =>
  Math.max(0, rows - Math.min(wrapText(message, width).length, Math.max(1, rows - 2)) - (rows >= 3 ? 1 : 0))

export const promptFrame = (message: string, lines: readonly string[], width: number, colors: TerminalPalette, complete: boolean, viewport?: { readonly rows: number; readonly columns: number }): string => {
  const rows = viewport?.rows ?? Infinity
  const framed = viewport === undefined || viewport.columns >= 8
  const title = wrapText(message, width).slice(0, Math.max(1, rows - 2))

  const output = title.map((line, index) => !framed ? paint(line, colors.primary) : index === 0
    ? `${paint(complete ? "◇" : "◆", colors.secondary)}  ${paint(line, colors.primary)}`
    : `${paint("│", colors.muted)}  ${paint(line, colors.primary)}`)

  for (const line of lines.slice(0, bodyRows(message, width, rows))) output.push(`${framed ? `${paint("│", colors.muted)}  ` : ""}${line}`)

  if (rows >= 3) output.push(framed ? paint("│", colors.muted) : "")

  return `${output.join("\n")}\n`
}

export const clearFrame = (frame: string, columns: number): string => {
  const lines = stripVTControlCharacters(frame).split("\n").slice(0, -1)
  const rows = lines.reduce((total, line) => total + Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, columns))), 0)

  return "\u001b[1A\u001b[2K\r".repeat(rows)
}

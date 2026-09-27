// Light violet from Jevvy's GitHub social preview (#A490F9).
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

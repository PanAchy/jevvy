import { homedir } from "node:os"
import { join } from "node:path"

export const globalJevvyConfigPath = (): string => {
  const override = process.env.JEVVY_CONFIG?.trim()

  if (override !== undefined && override.length > 0) return override

  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const root = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config")

  return join(root, "jevvy", "jevvy.jsonc")
}

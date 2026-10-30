import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({ plugins: [gui({ entry: "src/opencode/gui.ts" })] })

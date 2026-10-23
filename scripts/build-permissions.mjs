import { build } from "esbuild"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = new URL("../packages/permissions/", import.meta.url)

const common = {
  absWorkingDir: fileURLToPath(root),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
}

await build({
  ...common,
  entryPoints: { core: "src/core.ts", "core-schemas": "src/core-schemas.ts" },
  splitting: true,
  external: ["effect", "effect/*"],
  outdir: "dist",
})

const { createHistoryMetadata } = await import(new URL("dist/history/metadata.js", root))

await writeFile(new URL("dist/history/metadata-values.js", root), `export const historyMetadata = Object.freeze(${JSON.stringify(createHistoryMetadata())});\n`)

await build({
  ...common,
  entryPoints: {
    "claude-hook": "dist/claude/main.js",
    "claude-control": "dist/claude/control.js",
    "claude-history-worker": "dist/claude/history-worker.js",
  },
  mainFields: ["module", "main"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  outdir: "dist",
})

await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["src/claude/controls.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2023",
  outfile: "dist/claude-controls.js",
})

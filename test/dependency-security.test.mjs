import { createRequire } from "node:module"
import { createComponent, createResource, Suspense } from "solid-js"
import { renderToStringAsync, ssr } from "solid-js/web"
import { expect, it } from "vitest"

const project = createRequire(import.meta.url)

const solid = createRequire(project.resolve("solid-js"))

const seroval = solid("seroval")

const changesets = createRequire(project.resolve("@changesets/cli/package.json"))

const editor = createRequire(changesets.resolve("launch-editor"))

const shellQuote = editor("shell-quote")

it("rejects plugin-produced thenables before Promise deserialization invokes them", async () => {
  let invoked = false
  const sentinel = Object.freeze({ probe: true })

  const plugin = seroval.createPlugin({
    tag: "jevvy-security-thenable",
    test: (value) => value === sentinel,
    parse: { sync: () => ({}) },
    serialize: () => "({})",
    deserialize: () => ({
      then(resolve) {
        invoked = true
        resolve("unexpected-assimilation")
      },
    }),
  })

  const payload = await seroval.toJSONAsync(Promise.resolve("ordinary"))
  const node = seroval.toJSON(sentinel, { plugins: [plugin] }).t

  payload.t.f = { ...node, i: 1 }
  let failure

  try {
    await seroval.fromJSON(payload, { plugins: [plugin] })
  } catch (error) {
    failure = error
  }

  expect(invoked).toBe(false)
  expect(failure).toBeInstanceOf(Error)
})

it("preserves ordinary Promise and cyclic data deserialization", async () => {
  const value = {
    date: new Date("2026-10-15T00:00:00Z"),
    map: new Map([["status", "ok"]]),
    promise: Promise.resolve("ok"),
  }

  value.self = value

  const restored = seroval.fromJSON(await seroval.toJSONAsync(value))

  expect(restored.self).toBe(restored)
  expect(restored.date.toISOString()).toBe(value.date.toISOString())
  expect(restored.map.get("status")).toBe("ok")
  expect(await restored.promise).toBe("ok")
})

it("keeps Solid async rendering and hydration serialization compatible", async () => {
  const html = await renderToStringAsync(() => {
    const [value] = createResource(async () => ({
      message: "serializer-compatible",
      url: new URL("https://example.com/smoke"),
    }))

    return createComponent(Suspense, {
      fallback: "loading",
      get children() {
        return ssr(["<p>", "</p>"], value()?.message ?? "loading")
      },
    })
  }, { timeoutMs: 2000 })

  expect(html).toContain("serializer-compatible")
  expect(html).toContain("_$HY")
})

it("rejects line terminators after comment tokens before producing shell text", () => {
  expect(() => shellQuote.quote([{ comment: "probe" }, "first\nsecond"])).toThrow()
  const args = ["ordinary", "path with spaces", "ü"]
  expect(shellQuote.parse(shellQuote.quote(args))).toEqual(args)
})

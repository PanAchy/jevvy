import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"
import { Effect, ManagedRuntime } from "effect"
import { ReviewPresentation, ReviewPresentationError } from "../review-presentation.ts"
import type { ReviewIndicatorState } from "../review-indicator.ts"
import { JevvyControl } from "./rpc.ts"

export default Plugin.define({
  id: "jevvy.permissions.ui",
  async setup(ctx) {
    const rpc = ctx.client.rpc(JevvyControl)
    const location = ctx.location ?? ctx.data.location.default()
    const [state, setState] = createSignal<ReviewIndicatorState>({ enabled: undefined, dimmed: false })

    const runtime = ManagedRuntime.make(ReviewPresentation.layer({
      read: Effect.tryPromise({
        try: () => rpc.get(undefined, { location }),
        catch: () => new ReviewPresentationError({ message: "Could not read Jevvy's global configuration. Run npx @jevvy/permissions init or fix the configuration." }),
      }),
      toggle: Effect.tryPromise({
        try: () => rpc.toggle(undefined, { location }),
        catch: () => new ReviewPresentationError({ message: "Could not update Jevvy's global configuration. Check that it is writable and try again." }),
      }),
      render: setState,
      report: (message) => ctx.ui.toast.show({ title: "Jevvy", message, variant: "error" }),
    }))

    const presentation = await runtime.runPromise(ReviewPresentation)
    const stopEvents = rpc.events.on("changed", () => runtime.runPromise(presentation.refresh))

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "jevvy.permissions.toggle",
        title: "Toggle Jevvy",
        group: "Jevvy",
        palette: true,
        slash: { name: "jevvy" },
        run: () => runtime.runPromise(presentation.toggle),
      }],
    }))

    const disposeSlot = ctx.ui.slot({
      append: "prompt.footer.status",
      render: () => jsx("box", {
        paddingLeft: 2,
        flexShrink: 0,
        children: jsx("text", {
          get fg() {
            const enabled = state().enabled

            return enabled === undefined ? ctx.theme.text.muted : ctx.theme.text.feedback[enabled ? "success" : "error"].base
          },
          get attributes() { return state().dimmed ? TextAttributes.DIM : TextAttributes.NONE },
          children: "Jevvy",
        }),
      }),
    })

    return async () => {
      stopEvents()
      disposeSlot()
      await runtime.dispose()
    }
  },
})

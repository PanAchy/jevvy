import { Command, Plugin, Slot, createKeyed } from "@opencode/plugin/gui"
import { Effect, ManagedRuntime } from "effect"
import { createRenderEffect, createSignal, onCleanup } from "solid-js"
import { ReviewPresentation, ReviewPresentationError } from "../review-presentation.ts"
import type { ReviewStatus } from "../review-presentation.ts"
import type { ReviewIndicatorState } from "../review-indicator.ts"
import { JevvyControl } from "./rpc.ts"

const availableStatus = (status: ReviewStatus): ReviewStatus => ({
  ...status,
  enabled: status.problem === undefined ? status.enabled : undefined,
})

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<ReviewIndicatorState>({ enabled: undefined, dimmed: false })
    const [toggle, setToggle] = createSignal<(() => void) | undefined>()

    createKeyed(() => {
      const session = ctx.sessions.current()

      if (session?.location === undefined || !session.server.connected) return undefined

      return { client: session.server.client, directory: session.location.directory }
    }, ({ client, directory }) => {
      const rpc = client.rpc(JevvyControl)
      const location = { directory }
      let disposed = false

      setState({ enabled: undefined, dimmed: false })

      const runtime = ManagedRuntime.make(ReviewPresentation.layer({
        read: Effect.tryPromise({
          try: (signal) => rpc.get(undefined, { location, signal }),
          catch: () => new ReviewPresentationError({ message: "Could not read Jevvy Permissions status on this server. Check that its plugin is active and its global configuration is valid." }),
        }).pipe(Effect.map(availableStatus)),
        toggle: Effect.tryPromise({
          try: (signal) => rpc.toggle(undefined, { location, signal }),
          catch: () => new ReviewPresentationError({ message: "Could not confirm the Jevvy Permissions toggle. Check its status before trying again." }),
        }).pipe(Effect.map(availableStatus)),
        render: (next) => { if (!disposed) setState(next) },
        report: (description) => { if (!disposed) ctx.toast.show({ title: "Jevvy Permissions", description, variant: "error" }) },
      }))

      const refresh = () => { if (!disposed) runtime.runFork(Effect.flatMap(ReviewPresentation, (presentation) => presentation.refresh)) }

      const change = () => { if (!disposed) runtime.runFork(Effect.flatMap(ReviewPresentation, (presentation) => presentation.toggle)) }

      const stopEvents = rpc.events.on("changed", refresh)

      setToggle(() => change)

      refresh()

      ctx.add(Command, {
        id: "toggle",
        title: "Toggle Jevvy Permissions",
        run: change,
      })

      onCleanup(() => {
        disposed = true
        setToggle(undefined)
        stopEvents()
        void runtime.dispose()
      })
    }, {
      equals: (previous, next) => previous.client === next.client && previous.directory === next.directory,
      otherwise: () => {
        setState({ enabled: undefined, dimmed: false })
        setToggle(undefined)
      },
    })

    const statusTitle = () => state().enabled === undefined
      ? "Jevvy Permissions status unavailable"
      : `Jevvy Permissions auto-review ${state().enabled ? "enabled" : "disabled"}. Click to toggle globally on this server.`

    ctx.add(Slot, {
      at: "session.header",
      render(input) {
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = "Jevvy"
        button.style.cssText = "height:32px;padding:0 8px;border:0;border-radius:4px;background:transparent;font:inherit;font-size:12px"
        button.addEventListener("click", () => {
          if (input.active && input.session.key === ctx.sessions.current()?.key) toggle()?.()
        })

        createRenderEffect(() => {
          const enabled = state().enabled
          button.hidden = !input.active || input.session.key !== ctx.sessions.current()?.key
          button.disabled = button.hidden || toggle() === undefined
          button.title = statusTitle()
          button.setAttribute("aria-label", statusTitle())

          if (enabled === undefined) button.removeAttribute("aria-pressed")
          else button.setAttribute("aria-pressed", String(enabled))

          button.style.color = enabled === undefined ? "var(--text-weak)" : enabled ? "#15803d" : "#b91c1c"
          button.style.opacity = state().dimmed ? "0.35" : "1"
          button.style.cursor = button.disabled ? "default" : "pointer"
        })

        return button
      },
    })
  },
})

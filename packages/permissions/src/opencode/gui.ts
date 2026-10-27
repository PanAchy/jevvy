import { Command, ComposerPill, Plugin, createKeyed } from "@opencode/plugin/gui"
import { Effect, ManagedRuntime } from "effect"
import { createSignal, onCleanup } from "solid-js"
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

    ctx.add(ComposerPill, {
      id: "review",
      show(input) {
        if (input.session.key !== ctx.sessions.current()?.key) return undefined

        const enabled = state().enabled

        return {
          label: "Jevvy",
          title: statusTitle(),
          icon: enabled === undefined ? "circle-exclamation" : enabled ? "circle-check" : "circle-x",
          tone: enabled === undefined || state().dimmed ? undefined : enabled ? "success" : "danger",
          run: toggle(),
        }
      },
    })
  },
})

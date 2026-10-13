export const verifyControlCommand = async (api, directory) => {
  const commands = await api("GET", `/api/command?location[directory]=${encodeURIComponent(directory)}`)

  if (commands.data.filter((entry) => entry.name === "jevvy").length !== 1) {
    throw new Error("Native /jevvy must be registered exactly once")
  }

  const session = await api("POST", "/api/session", {
    title: "Jevvy native command smoke",
    location: { directory },
  })

  const control = `/api/rpc/jevvy.permissions.control/get?location[directory]=${encodeURIComponent(directory)}`

  for (const enabled of [false, true]) {
    await api("POST", `/api/session/${session.data.id}/command`, { name: "jevvy", text: "" })
    const status = await api("POST", control, {})

    if (status.output.enabled !== enabled) throw new Error("Native /jevvy did not persist the expected state")

    const pending = await api("GET", `/api/session/${session.data.id}/inbox`)
    const last = pending.data.at(-1)
    const description = `Jevvy ${enabled ? "enabled" : "disabled"}`

    if (last?.type !== "synthetic" || last.payload.description !== description || last.payload.text !== `${description}.`) {
      throw new Error("Native /jevvy did not record its persisted state")
    }

    const context = await api("GET", `/api/session/${session.data.id}/context`)

    if (context.data.some((message) => message.type === "assistant" || message.type === "idle")) {
      throw new Error("Native /jevvy unexpectedly started a model turn")
    }
  }
}

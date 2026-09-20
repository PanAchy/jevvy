# OpenCode adapter

This directory translates OpenCode host behavior into the provider-neutral permission engine. Keep policy in `evaluate.ts` and `../engine.ts`; keep SDK wiring in `index.ts`.

## Effect plugin boundary

- Use `@opencode/plugin/effect` directly and keep hook workflows Effect-native.
- Treat the OpenCode context as the host port. Do not leak SDK types into core provider modules.
- Registrations belong to the plugin scope. Tie future subscriptions, background fibers, streams, and client resources to that scope with explicit finalization.
- Keep the adapter thin: resolve credentials, construct the reviewer, install hooks, and report outcomes. Do not duplicate the permission truth table in SDK wiring.

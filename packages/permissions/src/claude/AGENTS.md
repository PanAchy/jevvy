# Claude Code adapter

Use Claude Code's synchronous `PermissionRequest` event with the `Bash` matcher. `PreToolUse` is outside Jevvy's approval-boundary contract.

- Decode the complete hook input before loading configuration or calling a provider.
- Emit only the documented one-action `allow` response. Never emit deny, ask, `updatedInput`, or `updatedPermissions`.
- Use a `SessionStart` `systemMessage` to report invalid configuration or missing credentials without making a permission decision.
- Permission-request abstention is exit 0 with zero stdout and stderr bytes. This includes Jev ask, timeout, malformed output, unavailable setup, provider failure, and unsupported input.
- Keep hook protocol mapping in `evaluate.ts`, global reviewer setup in `hook.ts`, and process I/O in `main.ts`.
- Treat each command-hook invocation as its own process lifetime. Do not add a daemon, IPC, or durable cache.

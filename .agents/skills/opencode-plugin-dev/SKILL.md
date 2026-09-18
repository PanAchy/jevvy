---
name: opencode-plugin-dev
description: Load, verify, and debug the jevvy plugin inside OpenCode. Use when changing plugin wiring, checking whether the plugin loaded, investigating load failures or hot-reload behavior, or dogfooding verdicts in a session.
---

# OpenCode plugin dev loop for jevvy

## Wiring

The dogfood entrypoint is `.opencode/plugins/jevvy/index.ts`: a one-line
re-export of `../../../src/plugin/index.ts`. Auto-discovery picks it up within
seconds of any change; edits under `src/` hot-reload (~100 ms, no restarts).

Two dead ends, already paid for:

- Relative `plugins` targets in config resolve against the server process
  cwd, not the config file. `".."` from `.opencode/opencode.json` became
  `/home/package.json` (`NpmInstallFailedError`).
- `file://` URLs were silently ignored by OpenCode 2.0.8: no entry, no error.

## Verify before any session test

```sh
opencode api get "/api/plugin?location[directory]=$PWD" \
  | python3 -c "import json,sys; [print(p.get('id'), p['state']['status']) for p in json.load(sys.stdin)['data'] if p.get('id') == 'jevvy']"
```

- No `jevvy` line: discovery has not run. Trigger it with a tiny headless run:
  `opencode run -m zai-coding-plan/glm-5.3 "reply ok"`.
- `failed`: the line carries an error ref (`err_xxxx`); find the cause with
  `grep "<ref>" ~/.local/share/opencode/log/opencode.log`.
- `active`: proceed with behavior tests.

Never declare the plugin working from a session test alone.

## Observing verdicts

```sh
grep -F "[jevvy]" ~/.local/share/opencode/log/opencode.log | tail
```

`[jevvy] loaded` shows `judge=live|degraded` (Config-found key or not).
`[jevvy] verdict` lines carry effect, source, and the command. Decisions also
persist (redacted) in plugin storage keys under `decision/`.

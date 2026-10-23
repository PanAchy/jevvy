# Delegate ask rules

Jevvy Permissions can review existing shell ask rules you explicitly nominate in your global `jevvy.jsonc`:

```json
{
  "permissions": {
    "reviewAskPatterns": {
      "opencode": ["*", "npm run *"],
      "claude": ["Bash(git *)"]
    }
  }
}
```

Each list applies only to its named host and defaults empty. Entries identify existing ask rules by exact string, not commands to approve. Spelling, case, slashes and whitespace are not normalized. A nomination is not automatic approval: Jevvy reviews the complete captured command once and approves only when every inquiry allows. Abstention or failure leaves the host's remaining reviewers, prompts and automatic approval settings unchanged. Final host allow and deny decisions remain untouched.

## OpenCode

OpenCode's exact `shell / * / ask` invitation remains enabled without nominations. Reload OpenCode after changing its list. For example, keep these rules in `opencode.jsonc`:

```json
{
  "permissions": [
    { "action": "*", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "npm run *", "effect": "ask" },
    { "action": "shell", "resource": "sudo*", "effect": "ask" }
  ]
}
```

- `pwd` reaches Jevvy through the nominated `*` rule.
- `npm run build` reaches Jevvy through the nominated `npm run *` rule.
- `sudo ls` stays with OpenCode because `sudo*` is not nominated.
- Non-shell requests remain with OpenCode. Final `allow` and `deny` decisions are unchanged.

OpenCode nominations identify resource-pattern strings. Listing `*` does not nominate `sudo*`, `**`, or `npm run *`. Matching follows OpenCode's last-rule-wins ordering, including effective agent and session rules; nominations apply to every winning rule with that spelling.

If any resource has an unlisted winning ask, Jevvy leaves the whole request with OpenCode. Non-shell requests are never delegated.

## Claude Code

Claude Code's exact `Bash` and `Bash(*)` review invitations remain enabled without nominations. Its list is read on each hook invocation. To use the example above, keep this native rule in a visible Claude settings file:

```json
{
  "permissions": {
    "ask": ["Bash(git *)", "Bash(git push *)"]
  }
}
```

- `git status` reaches Jevvy through the nominated `Bash(git *)` entry.
- `git push origin main` and `echo hello && git push origin main` stay with Claude because `Bash(git push *)` is not nominated, regardless of ask-list order.
- `Bash(git:*)` requires its own nomination even though Claude matches it like `Bash(git *)`.
- `*` nominates only an exact native `*` ask entry, not every ask rule. The hook still reviews only Bash `PermissionRequest` events.

Nominations support bare tool names or tool-name `*` globs matching Bash, and command selectors such as `Bash(git *)`. Malformed entries, input-parameter selectors such as `Bash(timeout:1000)`, and unrecognized semantics remain host-owned even if nominated. Quoting, wrappers, substitutions and other uncertain command matching still cause abstention when a command-specific ask exists, including a nominated one.

Claude evaluates deny before ask before allow, not last-match-wins. The command hook exposes neither the matched rule nor a complete effective configuration snapshot. Jevvy inspects visible user, project, local and worktree settings and preserves every potentially matching non-nominated ask. Managed, CLI and session rules are not visible to this inspection. Unreadable settings or unreliable command capture cause abstention. These nominations do not provide winning-rule fidelity or extend review beyond the existing permission-request boundary.

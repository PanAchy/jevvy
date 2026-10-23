# Delegate OpenCode ask rules

Jevvy Permissions already reviews OpenCode's exact `shell / * / ask` invitation. To delegate other shell asks, add `permissions.reviewAskPatterns` to your existing global `jevvy.jsonc` and reload OpenCode:

```json
{
  "permissions": {
    "reviewAskPatterns": ["*", "npm run *"]
  }
}
```

For example, keep these rules in `opencode.jsonc`:

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

Entries identify existing rules by their exact resource-pattern strings, not commands to approve. Listing `*` does not nominate `sudo*`, `**`, or `npm run *`. Spelling, case, slashes and whitespace are not normalized for nomination. Matching follows OpenCode's last-rule-wins ordering, including effective agent and session rules; nominations apply to every winning rule with that spelling.

An absent or empty list preserves existing behavior. If any resource has an unlisted winning ask, Jevvy leaves the whole request with OpenCode. Otherwise it reviews the complete captured shell command once. A review is not automatic approval: if Jevvy abstains or fails, OpenCode's remaining permission flow and automatic approval settings still apply.

This setting is OpenCode-only and does not change Claude Code behavior.

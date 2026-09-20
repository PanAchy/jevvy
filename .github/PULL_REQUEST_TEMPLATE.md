## Summary

<!-- What behavior changes, and why? -->

## Verification

<!-- List exact commands and outcomes. State any checks not run and why. -->

- [ ] Added or updated deterministic tests for behavior changes
- [ ] Ran `npm run check`
- [ ] Ran `npm run smoke:package` when package behavior or metadata changed
- [ ] Added a changeset for a user-visible change, or explained why none is needed

## Permission contract

- [ ] Uses a host shell approval boundary rather than a general pre-tool event
- [ ] Preserves host `allow` and `deny` decisions finalized before Jevvy
- [ ] Requires every inquiry to allow every resource and the complete command
- [ ] Leaves the host's remaining permission flow unchanged on uncertainty or failure
- [ ] Keeps credentials and policy outside repositories

---
"@jevvy/permissions": minor
---

## New harnesses

Add a Claude Code plugin that reviews Bash `PermissionRequest` events and grants one-action approval only when every Jevvy inquiry passes. All uncertain and unavailable outcomes leave Claude Code's remaining permission flow unchanged.

## Configuration

Report invalid Jevvy configuration and missing provider credentials when a Claude Code session starts, without changing any permission decision.

Let `jevvy init` install OpenCode, Claude Code, or both from one multi-select setup flow.

## Reliability

Support Node.js 22.19 and newer for setup, provider review, and Claude Code hooks.

## Fixes

Correct the MIT license attribution in the repository and published package.

## Breaking changes

Stop reading OpenCode login credentials for OpenCode Zen. Every harness now uses the selected provider's API key from the global Jevvy configuration or its native environment variable.

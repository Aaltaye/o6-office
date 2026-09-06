# T007 — Bridge DX: npx entry, README, coding fixture

**Status:** not_started  
**Branch:** `task/007-bridge-dx`  
**Phase:** 2  
**Depends on:** T005, T006  
**Can run in parallel with:** T008

## Goal

Make connecting a Claude Code session a two-minute job: one command, a printed hook block to paste, a printed URL. Rewrite the README around the two modes and commit a recorded coding-session run as the public demo.

## Research

- Current README structure — the run/edit/limitations sections to preserve and update.

## Acceptance criteria

- [ ] A single documented command starts the bridge and prints both the hook settings block and the office URL.
- [ ] bridge/hooks/settings-snippet.json is copy-pasteable into .claude/settings.json.
- [ ] README rewritten around the two modes; the scope-and-limitations section updated honestly, with stale claims about the static image and missing integrations removed.
- [ ] fixtures/recorded-coding-run.json committed, showing a real session including a subagent arriving and leaving.
- [ ] Setup notes and gotchas recorded in claudecode.md.

## Test requirements

- [ ] End-to-end: start the bridge, install the hooks in a scratch project, run a real Claude Code session that spawns a subagent, and confirm the specialist appears and leaves with usage attributed.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

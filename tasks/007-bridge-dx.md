# T007 — Bridge DX: npx entry, README, coding fixture

**Status:** done  
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

## Notes (execution)

`npm run bridge` generates a token, starts the server, writes a ready-to-paste hooks file
and prints its path plus the URL. An earlier version dumped ~90 lines of JSON into the
terminal, which is not a two-minute setup.

**No token is ever written into the repo.** The committed reference at
`bridge/hooks/settings-snippet.json` reads `$O6_BRIDGE_TOKEN`; the file the CLI writes
carries the real one and is gitignored. The hook commands end in `|| true` so a bridge
that is down can never interfere with the session it is visualising.

`fixtures/recorded-coding-run.json` is a real session mapped through the same code the
live bridge uses. Its provenance chain is stated in the file rather than implied:
transcripts → reconstructed hook payloads (redacted) → OfficeEvents. The recorder refuses
to write a fixture that fails validation, violates an invariant, or contains no subagent.

Capturing exposed two fidelity gaps in `scripts/capture-session.mjs`, both fixed: no
`prompt_id` (so no units of work appeared on the floor) and no session start/end.

**`bridge/public/` is gitignored** — it is build output. A fresh clone runs
`npm run build:bridge`, which the README says.

# T005 — Local bridge: hook receiver, SSE, transcript usage

**Status:** not_started  
**Branch:** `task/005-local-bridge`  
**Phase:** 2  
**Depends on:** T001  
**Can run in parallel with:** T006, T008

## Goal

A small local Node server that receives Claude Code hook POSTs, tails the session transcript for real token usage, and streams OfficeEvents to the browser over SSE while serving the office UI on the same origin. Session data never leaves the machine.

## Research

- CONFIRM per-specialist usage attribution against a real subagent run. PLAN.md flags this as designed-for but UNPROVEN: per-message usage and model were verified locally, but no transcript on this machine contained an isSidechain line at planning time. If attribution is unavailable, report session totals and say so — do not guess.
- Transcript line shape verified at planning: message.usage carries input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens and output_tokens_details.thinking_tokens; the top level carries sessionId, isSidechain, timestamp and cwd.

## Acceptance criteria

- [ ] bridge/server.mjs: hook POST endpoint, SSE stream, and static serve of the office UI on one origin.
- [ ] Bound to loopback only. Requires O6_BRIDGE_TOKEN and refuses to start without one rather than defaulting to open.
- [ ] Every inbound payload is validated before use — untrusted input is never trusted.
- [ ] bridge/transcript.mjs tails the transcript JSONL and emits usage.reported with a stated source.
- [ ] Bounded memory: O6_MAX_EVENTS caps the retained ring buffer.
- [ ] Port, token, poll interval and cap are all config. No magic numbers.
- [ ] Fails loudly on a missing or placeholder token, or an unreadable transcript.

## Test requirements

- [ ] Smoke: a synthetic hook POST produces a well-formed SSE OfficeEvent.
- [ ] Auth: a request without the token is rejected.
- [ ] The transcript parser extracts correct token counts from a committed sample line.
- [ ] Malformed hook payloads are rejected rather than crashing the bridge.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

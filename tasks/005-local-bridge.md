# T005 — Local bridge: hook receiver, SSE, transcript usage

**Status:** done  
**Branch:** `task/005-local-bridge`  
**Phase:** 2  
**Depends on:** T001  
**Can run in parallel with:** T006, T008

## Goal

A small local Node server that receives Claude Code hook POSTs, tails the session transcript for real token usage, and streams OfficeEvents to the browser over SSE while serving the office UI on the same origin. Session data never leaves the machine.

## Research

- **RESOLVED during T001 — per-specialist attribution works, by a different route than planned.** The earlier guess (an `isSidechain` flag in the parent transcript) was wrong: subagent activity never reaches the parent transcript at all. Each subagent has its own files at `.claude/projects/<project>/<sessionId>/subagents/`: `agent-<agent_id>.jsonl` (its messages, tool uses and per-message usage) and `agent-<agent_id>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`). `agent_id` is exactly what `SubagentStart` delivers, so the join is direct. Verified against a real run.
- Use `meta.json.description` as the specialist's desk label — it is their literal assignment, so it satisfies the no-invented-labels rule for free.
- `spawnDepth` lets the office represent nested subagents (an intern who calls in their own intern). Decide whether to render depth or flatten it.
- Consequence for the design: the bridge must watch a **directory**, not a single file — new `agent-*.jsonl` files appear as specialists spawn.
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

## Notes (execution)

Built together with T007 on one branch — the CLI, the served page and the server are one
user-facing thing, and splitting them would have meant shipping a bridge nobody could open.

**Per-subagent usage attribution is now proven, not just designed for.** The join works
exactly as T001 predicted: `agent-<id>.jsonl` beside the session transcript, `agent_id`
matching what `SubagentStart` delivers, and `meta.json` supplying the subagent's own
stated assignment. Tests cover attribution, incremental tailing, and a half-written
trailing line (transcripts are appended to while being read).

**Cost is deliberately not computed.** Tokens are reported because they are known; a
dollar figure would need per-model pricing this bridge has no business guessing at.

**Honest gap in the end-to-end replay:** `scripts/replay-hooks.mjs` drives real payloads
through the real server, but the reconstructed capture omits `transcript_path` (it is a
filesystem path, and the capture redacts those). So the replay exercises hooks and SSE
but not the transcript watcher — `/health` reports `watching: 0`. A genuine live session
carries the path and usage does flow; the watcher itself is covered by unit tests against
a real on-disk layout.

**Security posture:** loopback only, token required and refused if absent, short, or a
placeholder; every payload validated; body size capped; static serving contained to
`bridge/public` with route-shaped fallback only (a probe for `/package.json` gets a 404,
not the app shell — that was a real looseness the tests caught).

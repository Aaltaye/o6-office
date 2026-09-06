# T006 — Claude Code hook mapping & coding floor plan

**Status:** done  
**Branch:** `task/006-claude-code-mapping`  
**Phase:** 2  
**Depends on:** T001  
**Can run in parallel with:** T005, T008

## Goal

Map Claude Code hook payloads onto OfficeEvent, and define the coding-session floor plan whose departments match how a coding session actually works rather than reusing the lead-workflow desks.

## Research

- Hook events and fields recorded in PLAN.md "Verified findings": SubagentStart/Stop carry agent_type and agent_id; Pre/PostToolUse carry agent_id when inside a subagent; PostToolUseFailure carries tool_error; PermissionRequest is the approval beat; PostToolBatch carries a tool_calls array.

## Acceptance criteria

- [ ] bridge/map-claude-code.mjs maps each supported hook to an OfficeEvent per the table in PLAN.md.
- [ ] The tool-to-desk mapping is a config table, not a switch buried in logic: Read/Grep/Glob to the reading room, Edit/Write to the workshop, Bash to operations, WebFetch/WebSearch to research, Task to the front desk, permissions to approvals.
- [ ] SubagentStart maps to specialist.joined with agent_type as the role; SubagentStop maps to specialist.left, correlated by agent_id.
- [ ] PostToolBatch fans out to concurrent assignment.started events preserving array order.
- [ ] Unknown or future hook events are ignored safely with a logged note and never crash the bridge.
- [ ] lib/floorplans/coding-session.ts conforms to the FloorPlan schema.

## Test requirements

- [ ] Each supported hook payload maps to the expected OfficeEvent (table-driven over committed sample payloads).
- [ ] A subagent lifecycle — start, tool calls carrying agent_id, stop — produces a joined/assignments/left sequence correlated by agent_id.
- [ ] An unknown hook_event_name is ignored without throwing.
- [ ] The coding-session floor plan validates and its desk ids are unique.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

## Notes (execution)

Done before T005 rather than in parallel: the bridge consumes this mapping, so building
it first meant the server had something real to serve.

**On simultaneity.** Parallel tool calls each fire their own `PreToolUse`, arriving a few
milliseconds apart rather than at one instant, so `groupSimultaneous` will not collapse
them. That is left alone deliberately. The scheduler orders by `occurredAt` and preserves
real gaps, so calls milliseconds apart still animate together (per-event jitter is 220ms),
while genuinely sequential calls seconds apart do not. Rounding timestamps to force one
group would invent a simultaneity the session never reported.

`PostToolBatch` is recognised and skipped with a stated reason: every call in the batch
already fired its own Pre/PostToolUse, so mapping it too would double-count.

**Unknown hooks are ignored but never silently.** Claude Code gains hook events over
time; the mapping returns an `ignored` reason and the bridge logs it, so a new event
shows up as a gap to fill rather than disappearing.

Verified against the whole captured session (261 hook records): every hook recognised,
every mapped event valid, the stream schedules onto the coding plan with no invariant
violations, the single subagent arrives and leaves correlated by `agent_id`, and all nine
real failures stay failures.

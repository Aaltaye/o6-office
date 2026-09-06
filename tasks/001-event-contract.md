# T001 — Event contract & floor-plan schema

**Status:** not_started  
**Branch:** `task/001-event-contract`  
**Phase:** 1  
**Depends on:** none  
**Can run in parallel with:** T008

## Goal

Define the versioned, producer-agnostic OfficeEvent contract and the declarative floor-plan schema. This is the seam the whole project hangs on: the renderer consumes only this, and both the lead workflow and the Claude Code bridge produce only this. Pure types, data and validators — no UI, no React.

## Research

- lib/lead-engine.ts — existing WorkEvent/Department types being generalised (read before writing).
- lib/use-office.ts — the log() call sites that become emit() in T003.
- PLAN.md "The event contract" section — the agreed envelope shape.
- Claude Code hook payload fields are recorded in PLAN.md "Verified findings"; the contract must carry all of them without needing a v2 bump.

## Acceptance criteria

- [ ] lib/office-events.ts exports OfficeEvent (v:1) covering every event type listed in PLAN.md.
- [ ] Exports a FloorPlan type: rooms, desks (id, role, world x/y, facing), door position, inbox/outbox tray positions, and walking paths between desks.
- [ ] Exports isOfficeEvent(x): a strict runtime validator. The bridge accepts untrusted input, so this must genuinely validate, not cast.
- [ ] Exports a stable ordering comparator (ts, then monotonic seq) so simultaneous events keep deterministic stream order.
- [ ] lib/floorplans/lead-reactivation.ts exports the six-department floor plan conforming to the schema.
- [ ] No React import and no lead-engine import. The contract must not know what a lead is.

## Test requirements

- [ ] isOfficeEvent accepts every valid event type and rejects: missing v, wrong v, unknown type, missing label, non-numeric ts.
- [ ] Ordering comparator preserves insertion order for identical timestamps (the burst-of-5 case).
- [ ] The lead-reactivation floor plan validates against the FloorPlan schema and every desk id is unique.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

## Amendments from the architecture review

See PLAN.md sections A1–A8 and C1–C4. Additional requirements for this task:

- [ ] Events carry BOTH `occurredAt` and `receivedAt`, plus a monotonic `seq` (invariant I5: five parallel tool calls in the same millisecond are genuinely simultaneous and must never be serialised into an ordering that did not happen).
- [ ] `handoff` carries an explicit `direction: "forward" | "backward"`. Never inferred from "the destination happens to be upstream" — the carried-backward beat has its own path, pacing and label, and both producers must be able to state it (C2).
- [ ] Every event carries an opaque `payload` for the inspection panel.
- [ ] FloorPlan declares: rooms, stations (seat, facing, inTray, outTray, `hotDesk?`), roles, doors, an aisle graph with `lanes`, outbox, and a `compact` variant for mobile (A8).
- [ ] `compileFloorPlan()` derives depth bands (`desk-back` / `desk-seat` / `desk-front` per station), anchors, and an all-pairs shortest-path table over the aisle graph — precomputed, so there is zero runtime pathfinding and therefore zero nondeterminism (A2).
- [ ] `compileFloorPlan()` validates depth-monotonicity of every aisle edge and warns loudly in dev.
- [ ] **Capture a real Claude Code session hook stream to `fixtures/captured-coding-session.json`** so T002 can prove burst behaviour against real data long before the bridge exists (C4 — this is the top product risk).

**Test additions**

- [ ] Ordering comparator sorts by `occurredAt` then `seq`, and simultaneous events remain simultaneous rather than being serialised.
- [ ] `compileFloorPlan` rejects a plan with a non-depth-monotonic aisle edge.
- [ ] The captured coding fixture validates against the contract.

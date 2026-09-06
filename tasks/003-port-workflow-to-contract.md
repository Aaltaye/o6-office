# T003 — Port the lead workflow to emit OfficeEvent

**Status:** not_started  
**Branch:** `task/003-port-workflow-to-contract`  
**Phase:** 1  
**Depends on:** T002  
**Can run in parallel with:** T008

## Goal

Refactor lib/use-office.ts to emit OfficeEvent instead of the ad-hoc WorkEvent shape, including the handoff and specialist events the renderer needs. lib/lead-engine.ts stays untouched — it is the strongest code in the repo and its tests must remain green.

## Research

- lib/use-office.ts log() and move() call sites — each becomes a typed emit().
- Which moments legitimately map to specialist.joined: the live-AI Context/Outreach/Review assignments are bounded model calls, so they qualify. Local-rules mode must NOT fake a specialist.

## Acceptance criteria

- [ ] use-office.ts emits only OfficeEvent, validated by isOfficeEvent in development.
- [ ] Department handoffs emit handoff events carrying from/to desk ids.
- [ ] Live-AI assignments emit specialist.joined/left; local-rules mode emits neither (honesty rule: nothing animated that did not happen).
- [ ] A failed review emits assignment.failed so the folder visibly returns.
- [ ] usage.reported events carry their source and are absent — not zero — in local mode.
- [ ] All 20 existing tests still pass unchanged.
- [ ] A completed run serialises to a plain OfficeEvent[] suitable for replay.

## Test requirements

- [ ] A sample run emits a well-formed stream where every event passes isOfficeEvent.
- [ ] Local-rules mode emits zero specialist.joined and zero usage.reported events.
- [ ] Excluded and held leads emit assignment events terminating with a stated reason.
- [ ] Regression: existing lead-engine and API tests unchanged and green.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

## Amendments from the architecture review

See PLAN.md corrections C1–C3. **C1 is blocking for the demo and must be resolved in this task.**

- [ ] **C1 — the flagship beat currently has no event to fire on.** A rejected draft sets `state=hold` and `processed=true` with no edge back to Outreach, and in local-rules mode (the default public demo path) Review always completes. So "the reviewer sends work back" would never appear. Resolve honestly — do NOT fabricate a rework loop to earn an animation (that violates invariant I2). Implement a real rework edge: a held draft genuinely returns to Outreach for one retry carrying the reviewer's specific reason, and the retry genuinely re-runs.
- [ ] **C2** — `move()` logs only at the destination, so handoff edges must be synthesised by tracking each lead's previous department. Emit explicit `direction`.
- [ ] **C3** — `toggleSpeed` currently divides the `await wait(...)` that paces the work itself. Speed becomes strictly a playback control; the two meanings must not share a variable.
- [ ] Delete the `active` map — who-is-where is derived from the event log. Do not maintain two sources of truth.

**Test additions**

- [ ] The rework edge fires on a genuinely failed review and the retry genuinely re-runs; the emitted stream contains a `handoff` with `direction: "backward"`.
- [ ] Workflow pacing is unaffected by the playback speed control.

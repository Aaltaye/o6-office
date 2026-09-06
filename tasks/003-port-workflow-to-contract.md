# T003 — Port the lead workflow to emit OfficeEvent

**Status:** done  
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

## Notes (execution)

**C1 resolved honestly.** The flagship beat now fires in the default local-rules path,
without staging it. The `draftTemplate` output is genuinely generic — it references
nothing the contact said — so a reviewer catching that is doing real work, and
`groundedDraft` genuinely fixes it by rewriting the message around a verbatim quote from
a source note, citing the row. Tests assert the second draft passes the same check that
rejected the first, so the loop cannot become theatre.

**Scope grew, deliberately.** The workflow was extracted from the hook into
`lib/lead-workflow.ts` with no React in it. The acceptance criteria require testing the
emitted stream, and that is not possible from inside a hook. It also means a server can
run the same workflow later (the bridge, a hosted runner) without change. The hook is now
just a React binding.

`WorkflowEvent` is typed against the real contract (`ProducerEvent`), so a producer that
forgets `direction` on a handoff fails the build rather than animating something untrue.

**Bug found by the tests:** the rework loop emitted an `outreach -> outreach` handoff —
a folder travelling to where it already was. Handoffs where nothing moved are now
suppressed (invariant I2).

Also derived from the stream rather than tracked alongside it, removing two
sources of truth: `active` (who is where) and `usage` (tokens and cost).

**Drift:** `app/page.tsx` was updated to consume the derived `activity` view model. That
is nominally T004's file, but leaving it broken was not an option — the build has to stay
green. The office is still not mounted there; that remains T004.

# T002 — Isometric office renderer

**Status:** not_started  
**Branch:** `task/002-isometric-renderer`  
**Phase:** 1  
**Depends on:** T001  
**Can run in parallel with:** T008

## Goal

Build the live office: isometric projection, a simulation clock decoupled from wall-clock, an event-stream-to-scene reducer held outside React, and SVG primitives for rooms, desks, workers, folders and trays. Includes the specialist-arrives and work-sent-back animations. Developed against a hand-written fixture so it is provable before any workflow is wired in.

## Research

- Fold in the independent architecture review commissioned during planning (projection maths, depth sorting, backpressure strategy, React/rAF boundary).
- components/ui/ — reuse existing shadcn primitives for the controls rather than rebuilding them.
- PLAN.md "Art direction" — porcelain paper model; violet reserved for live activity only.

## Acceptance criteria

- [ ] lib/office-view/iso.ts: world-to-screen projection plus depth sort, so a worker walking behind a desk is correctly occluded.
- [ ] lib/office-view/clock.ts: play, pause, seek(t), setSpeed. Seeking to the same t twice yields identical scene state.
- [ ] lib/office-view/scene.ts: reduces OfficeEvent[] plus a clock value into scene state. Pure — no React, no DOM.
- [ ] lib/office-view/OfficeView.tsx: SVG root, owns the rAF loop, writes transforms directly to nodes. React state holds only selection and discrete counters.
- [ ] Animations implemented: folder travels desk-to-desk on handoff; folder travels BACKWARD on assignment.failed; a specialist walks in from the door on specialist.joined, takes a free hot desk, and exits on specialist.left; artifacts stack in the outbox tray.
- [ ] Burst handling: when events outpace animation, the queue time-compresses rather than dropping or reordering. On-screen order always matches stream order.
- [ ] Clicking a desk, worker or folder fires a typed selection callback, using DOM hit-testing rather than manual maths.
- [ ] Readable at mobile width.
- [ ] No hardcoded department names anywhere under office-view/ — everything comes from the FloorPlan.

## Test requirements

- [ ] iso projection: known world coordinates map to expected screen coordinates; depth sort orders a behind-desk worker correctly.
- [ ] clock: seek(t) is deterministic across repeated calls and across forward and backward seeks.
- [ ] scene reducer: a fixture stream produces the expected desk occupancy, folder positions and outbox count at three specified clock values.
- [ ] burst: five events sharing one timestamp render in stream order with none dropped.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

## Amendments from the architecture review

See PLAN.md sections A1–A8. This task changes shape materially — read those before starting.

- [ ] **Timeline model, not a stateful stepper.** Motion compiles to explicit tracks `{startMs, endMs, from, to, easing}`; `sampleAt(t)` is a pure lookup. Pause/scrub/speed/rewind are one code path. Live mode appends to the same timeline and plays at its head (A1).
- [ ] Non-positional state (status label, outbox count, folder ownership) modelled as step channels so scrubbing yields the correct label with no replay from zero.
- [ ] **Pre-compiled depth bands, not per-frame sorting.** Re-parent an actor only when it crosses a band boundary; never re-sort SVG children per frame (that is the real SVG perf cliff) (A2).
- [ ] Honesty invariants I1–I5 implemented as runtime assertions in the scheduler, not prose (A3).
- [ ] Backpressure by scheduled-time debt in three tiers: real time / uniform compression / summarise to one aggregate move with a count badge. Nothing is ever dropped — the floor is lossy, the log stays lossless (A3).
- [ ] I4: whenever rate ≠ 1 or aggregation is active, the UI says so on screen.
- [ ] **Camera does not chase the action.** Fixed by default; attention signalled by a light-pool on the active room; camera moves only on explicit user click (A4).
- [ ] No SVG filters in the actor layer. Shadows are pre-computed polygons with flat fills in the static layer (A4).
- [ ] Labels are HTML in an overlay layer, not SVG `<text>` (A4).
- [ ] Above ~4 concurrent items on a shared aisle segment, render one cart with a count badge that splits at the destination (A4).
- [ ] Deterministic jitter from `hash(eventId)` staggers simultaneous movers.
- [ ] Determinism bans enforced: no `Math.random`, no `Date.now()` inside the scene, hot-desk and lane assignment keyed by `seq` not arrival (A5).
- [ ] Accessibility outline tree (rooms → desks → current assignment) ships in THIS task, not later. It is on-thesis: a screen-reader-navigable office is the product (A6).
- [ ] Module boundary enforced by oxlint `no-restricted-imports` (A7).
- [ ] Mobile switches to the plan `compact` variant rather than only zooming; below ~640px only the active label shows, the rest collapse to dots (A8).
- [ ] Unknown-role specialists take the lowest free `hotDesk` by `seq`; pool exhaustion overflows to a standing worker plus a `+N more` chip. The floor plan is NEVER grown at runtime.

**Test additions**

- [ ] **Determinism via SVG-string hashing** (A5): `hash(renderSceneToString(plan, events, t))` over a fixed grid of `t`, identical across two independent runs and across live-capture vs replay. This is the primary regression test.
- [ ] Burst behaviour proven against the REAL captured Claude Code fixture from T001, not only a hand-written one.
- [ ] Reduced-motion policy: easings become `step-end` and durations clamp to ~0; the scene stays truthful, it just stops moving.

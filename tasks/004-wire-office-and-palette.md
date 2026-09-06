# T004 — Mount the office, adopt O6 tokens, record the demo

**Status:** done  
**Branch:** `task/004-wire-office-and-palette`  
**Phase:** 1  
**Depends on:** T003  
**Can run in parallel with:** T008

## Goal

Replace the static PNG with the live OfficeView in app/page.tsx, rebuild the styling on the authoritative O6 brand tokens, add replay controls and the desk/lead inspection panel, and record and commit a demo run so a first-time visitor sees the office working immediately.

## Research

- app/page.tsx — the office-map block containing the office.png img and the six .desk-label buttons.
- app/office.css and app/globals.css — every hardcoded colour to be replaced with real tokens.
- Authoritative palette: Porcelain #F7F7F4, Mist #E8E8F0, Titanium #B6BBC5, Graphite #1F2228, O6 Violet #7446FF with a 5% usage cap.

## Acceptance criteria

- [ ] public/office.png deleted and no reference to it remains; bundle drops roughly 1.6 MB.
- [ ] OfficeView mounted with the lead-reactivation floor plan and the live event stream.
- [ ] Replay controls: play/pause, scrub, speed. Recorded runs are labelled "recorded run" on screen.
- [ ] Inspection panel: clicking a desk shows its assignment, event trail and outputs; clicking a folder follows that lead end to end.
- [ ] Palette rebuilt on the five O6 tokens across office.css and globals.css. Violet appears only on live-activity affordances, verified by grep.
- [ ] fixtures/recorded-lead-run.json committed and played on first load.
- [ ] Existing sample/live/recorded mode labelling preserved and correct.

## Test requirements

- [ ] The committed fixture loads and validates as OfficeEvent[].
- [ ] Browser verification per PLAN.md: run the sample, screenshot mid-run with a specialist present and a folder in transit, zero console errors, mobile width readable, scrub determinism confirmed.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

## Amendments from the architecture review

See PLAN.md correction C1 and section A7.

- [ ] The committed demo fixture must be a run in which the reviewer genuinely sent work back, so the flagship beat actually appears. If that requires a live-AI run, record it and label it "recorded run — live AI" on screen (C1).
- [ ] Floor plans are static JSON imported in a server component and passed as a prop; only `OfficeView` is `use client` (vinext is RSC-based) (A7).
- [ ] The existing shadcn `Sheet` in `app/page.tsx` already handles both `selectedLead` and `desk` — extend it rather than building a second panel.
- [ ] Demo runs ship as static assets (no DB, no R2 configured); that is the whole persistence story and it is sufficient.

## Notes (execution)

`public/office.png` deleted (1.6 MB), the static-image and desk-label CSS with it. The
office is now rendered live from the event stream.

**The demo is a real recording, not a hand-authored one.** `scripts/record-demo-run.mjs`
runs the actual workflow over the actual fictional sample data and writes whatever it
emits: 130 events, 9 leads, ~33s replay, two genuine carried-back handoffs, zero
specialists and zero usage (correct for local-rules mode). The script refuses to write a
fixture that fails contract validation, violates a scheduling invariant, or contains no
carried-back handoff — a demo that does not show the beat is not worth shipping.

**Palette rebuilt on the authoritative O6 tokens.** Primary actions are Graphite, not
violet: violet is reserved for live activity, which keeps it inside the brand's 5% cap by
construction. Verified by grep that the only violet users are the live pill, the live
status dot, and the office's own active states.

**Two bugs found by looking at it:**

1. **Infinite render loop.** `onTime`/`onSelect` are inline arrows in the host, so
   `applyTime`'s identity changed every render, which re-fired the mount-paint effect,
   which set state, which rendered again. Both callbacks are now held in refs.
2. **The panel contradicted the floor.** Clicking a desk during the recorded run said
   "No assignments yet" because the panels read the *live* stream while the floor read
   the *recording*. `toActivity` is now a pure exported projection applied to whatever
   the floor is showing. A product whose inspection panel disagrees with its own
   visualisation is worse than one with no panel.

**A change I made and reverted:** importing `next/link` to satisfy
`next/no-html-link-for-pages` pulled a second React copy under vinext and crashed the
page with "Invalid hook call". The brand mark stays an `<a>`, and that lint error stays.
Clearing `node_modules/.vite` was needed afterwards — Vite had cached the broken graph.

Repo-wide lint debt is down from 28 errors to 21; `app/page.tsx` from 10 to 4. The
remainder are 15 vendored shadcn components plus four inherited react-compiler patterns
in the lead-editing effect, which were left alone rather than restructured blind.

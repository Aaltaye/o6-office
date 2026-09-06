# T004 — Mount the office, adopt O6 tokens, record the demo

**Status:** not_started  
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

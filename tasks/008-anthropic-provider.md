# T008 — Add Anthropic as a selectable provider

**Status:** not_started  
**Branch:** `task/008-anthropic-provider`  
**Phase:** 2  
**Depends on:** none  
**Can run in parallel with:** T001-T007 (disjoint files)

## Goal

Add Claude alongside the existing OpenAI path for the lead workflow live mode, reusing the existing validating server proxy, structured-output schema and exact-source-quote checks. The OpenAI path keeps working.

## Research

- app/api/agent/route.ts — the existing proxy, schema validation and evidence-quote checking to be shared, not duplicated.
- Current pricing constants and the README pricing note (verified 2026-09-06) — add Claude pricing alongside and keep the verification date honest.

## Acceptance criteria

- [ ] Provider is selectable in run settings and the choice is reflected in the on-screen run-mode label.
- [ ] Both providers share one validation path — schema and exact-source-quote checks are not forked.
- [ ] Key format validation per provider. Keys stay browser-held and are never persisted, logged, or written to the repo or hosting metadata.
- [ ] Usage and cost reported per provider with correct pricing and a stated verification date.
- [ ] README updated to describe both providers.

## Test requirements

- [ ] A mocked Anthropic response passes schema and quote validation.
- [ ] A response containing a quote absent from the source records is rejected, for both providers.
- [ ] Existing mocked OpenAI API contract tests stay green.

## Commits

_(filled during execution)_

## Drift reason

_(blank — fill if scope changed during execution)_

## Notes

_(blockers, decisions, paused reasons)_

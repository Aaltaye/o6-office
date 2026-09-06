# T008 — Add Anthropic as a selectable provider

**Status:** done  
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

## Notes (execution)

**Provider is inferred from the key** (`sk-ant-` → Anthropic, else OpenAI), so there is no
extra setting to configure and nothing to get out of sync with the key you pasted. The
run-mode label on screen names whichever provider actually ran.

**One validation path, deliberately.** The schema check and the exact-source-quote check
are shared, and a test proves invented evidence is rejected on the Anthropic path too.
Forking them per provider would have meant one quietly getting weaker guarantees — and the
quote check is the thing standing between a personalised draft and an invented one.

**Raw HTTP rather than the Anthropic SDK.** This is one small proxy running in a
Cloudflare Worker that already spoke raw HTTP to OpenAI; adding an SDK for one provider
only would leave the file half in each idiom. Noted because the Claude API guidance
prefers the SDK by default.

**Model defaults are the vendors' current general models** (`claude-opus-5`,
`gpt-4.1-mini`), overridable via `O6_ANTHROPIC_MODEL` / `O6_OPENAI_MODEL`. Deliberately
not defaulted to the cheapest Claude tier: choosing a smaller model to save money is a
decision for whoever pays the bill, so it is exposed rather than assumed.

**Cost estimates are an upper bound.** Where a cached-input rate is not pinned for a
model, cached tokens are priced at the full input rate, and an unknown model returns null
rather than a fabricated figure. Prices carry a verification date.

A refusal is surfaced as a refusal rather than as unreadable output — an honest outcome
deserves an honest message.

# O6 Office — Live Office + Claude Code Adapter

**Status:** APPROVED · drafted 2026-09-06 · approved 2026-09-06
**Repo:** `C:\Users\Altay\Projects\o6-office` (relocated from the Codex scratch path; baseline committed as `0d0d970`)

---

## Context

O6 Office is Experiment 001 of the O6 Invention Lab, under the theme *make invisible work visible*. The pitch: people can't tell how capable agentic AI is because the work is invisible. Show it as an office they already understand — desks, folders, handoffs, an intern called in for a bounded job — and they get it in seconds.

A prior Codex session built a working prototype: a careful deterministic lead-reactivation engine, an optional live-model path with source-quote validation, CSV import/export, and honest labelling throughout. That part is good and stays.

**What it does not have is the invention.** The "office" is a 1.6 MB static PNG with six HTML labels absolutely positioned on top at hardcoded percentages (`app/page.tsx`, search `office.png`; `.desk-label` in `app/office.css`). There is no spatial model, no characters, no motion, no handoff. Every desk reads "View completed work." The single most memorable beat — a specialist walking in for a bounded assignment, and a reviewer carrying work *back* — does not exist.

There is also no "connect your work" path. The workflow runs entirely inside a React hook in the browser, so there is nothing for an external agent runtime to talk to.

**Outcome:** a real rendered office driven by a versioned, producer-agnostic event contract; the lead workflow becomes one producer of that contract; a local bridge makes a live Claude Code session a second producer. Same office, two very different kinds of work.

## Verified findings that shape the design

Checked during planning, not assumed:

- **Claude Code hooks map almost one-to-one onto the office metaphor.** `SubagentStart` fires on spawn and carries `agent_type` + `agent_id` — that is the intern walking in, as a real event. `SubagentStop` closes it. `PreToolUse`/`PostToolUse` carry `agent_id`/`agent_type` when inside a subagent, so activity attributes to the right worker. `PostToolUseFailure` (with `tool_error`) is work coming back. `PermissionRequest` is an approval landing on the manager's desk. `PostToolBatch` carries a `tool_calls` array — several desks lighting up at once.
- **Token usage is NOT in any hook payload.** But every hook carries `transcript_path`, and the transcript JSONL carries real per-message `usage` (input, `cache_creation`, `cache_read`, output, thinking tokens) plus `model`, and `isSidechain: true` is documented as the subagent marker. So usage is real — read from the transcript, labelled as such. We do not estimate.
  *Correction, resolved during T001.* The caveat here previously said per-specialist attribution was "designed-for but unproven", and guessed it would come from an `isSidechain` flag in the parent transcript. **That guess was wrong — and attribution turns out to be available by a better route.** Subagent activity never reaches the parent transcript at all (zero `isSidechain` lines anywhere on this machine, including immediately after a subagent ran). Each subagent instead gets its own pair of files:

  ```
  .claude/projects/<project>/<sessionId>/subagents/
      agent-<agent_id>.jsonl       the specialist's own messages, tool uses, per-message usage
      agent-<agent_id>.meta.json   { agentType, description, toolUseId, spawnDepth }
  ```

  `agent_id` is exactly what `SubagentStart` delivers, so the join is direct. Verified against a real run: a `Plan` subagent's file yields its model (`claude-opus-5`), the tools it used (`Bash`, `Read`), and its attributed totals — 993,117 cache-read / 161,214 cache-creation / 997 output / 52 thinking tokens.

  Two things this route gives us that the parent transcript would not have:
  - `meta.json.description` is the specialist's *actual assignment* ("Design office renderer architecture") — a literal, non-invented desk label, which is exactly what the honesty rule asks for.
  - `spawnDepth` makes nested subagents representable: an intern who calls in their own intern.
- **The current palette is off-brand.** The build uses `#3854ef` / `#f7f8fb`. O6's authoritative tokens are Porcelain `#F7F7F4`, Mist `#E8E8F0`, Titanium `#B6BBC5`, Graphite `#1F2228`, O6 Violet `#7446FF` — with violet capped at ≤5% of any application.

## Goal

Replace the static office with a live isometric office rendered from a versioned event contract, so that (1) the lead workflow is watchable and shareable, and (2) a developer can run one command locally and watch their own Claude Code session render in the same office. Ship a committed recorded run so a visitor sees the thing working instantly without waiting for a job or supplying a key.

## Non-goals

- Not a hosted multi-tenant SaaS. No auth, no accounts, no server-side persistence this round.
- No Codex or Replit adapters. Claude Code only; the contract leaves room for more.
- No message sending. Review stays a human decision.
- No external enrichment or web research in the lead workflow.
- Not publishing an npm package yet — the renderer gets a clean extractable boundary, but stays in-repo.
- No license decision (still open, per the README).

## Art direction

The office is a **near-monochrome porcelain paper model**: Porcelain ground, Mist surfaces, Titanium structure and edges, Graphite type. **O6 Violet is reserved exclusively for "this is happening right now"** — the active desk, the folder in transit, the live meter. Nothing else is violet. That satisfies the ≤5% brand cap by construction *and* makes the eye land on live activity with no extra work.

Depth comes from alpha layering and flat tonal steps, not drop shadows (per the O6 design playbook). Characters are simple faceless figures — posture and motion carry the meaning, no faces to fall into the uncanny valley, and it matches the LM house-cast convention already used elsewhere.

**Honesty rules, carried forward from the existing build and non-negotiable:**
- Labels state the literal action ("Reviewing draft against source notes"). We never render invented agent "thoughts."
- Sample vs live vs recorded is always marked on screen.
- Nothing is animated that did not happen. Ordering on screen matches ordering in the event stream.
- Usage figures cite their source; unavailable usage renders as unavailable, not as zero.

## Stack decisions

| Decision | Choice | Why |
|---|---|---|
| Renderer substrate | Inline SVG in React | Crisp at any zoom (we zoom into desks), native DOM hit-testing for click-a-desk, accessible, no new heavy dependency, composes with React. Canvas loses hit-testing and a11y; WebGL is overkill for ~60 moving elements and hurts the mobile bundle. |
| Animation | `requestAnimationFrame` against a **simulation clock decoupled from wall-clock** | Pause, scrub, rewind and speed control all fall out of it. CSS transitions/WAAPI cannot be scrubbed coherently across many elements. |
| Simulation state | Held in refs, mutated in the rAF loop, written directly to SVG attributes | Keeps 60fps animation out of React's render path. React state holds only discrete UI concerns (selection, panel contents, counters). |
| Floor plan | Declarative data (rooms, desks, roles, paths), one per workflow | The Claude Code floor plan and the lead floor plan are different offices; the renderer must not know either. Also satisfies the configurability-over-hardcoding rule. |
| Bridge transport | Local Node process, SSE to the browser, serving the office UI itself on the same origin | Session data never leaves the machine (a real selling point, not a limitation). Same-origin avoids the https-page → http-localhost mixed-content question entirely. |
| Existing engine | Keep `lib/lead-engine.ts` essentially as-is | It is the strongest code in the repo. Only `use-office.ts` is refactored, to emit the contract. |

## File structure

```
lib/
  office-events.ts        NEW  versioned event contract + floor-plan schema (the seam)
  office-view/            NEW  the renderer (extractable later)
    iso.ts                     world→screen projection, depth sort
    clock.ts                   simulation clock: play/pause/seek/speed
    scene.ts                   event stream → scene state (refs, no React)
    OfficeView.tsx             React shell, SVG root, hit-testing
    parts/                     Desk, Worker, Folder, Tray, Room primitives
  floorplans/             NEW
    lead-reactivation.ts       6 departments (existing workflow)
    coding-session.ts          reading / workshop / shell / research / approvals
  lead-engine.ts          KEEP unchanged
  use-office.ts           EDIT emit OfficeEvent instead of ad-hoc WorkEvent
app/
  page.tsx                EDIT drop the <img>, mount OfficeView, add replay controls
  office.css              EDIT rebuild on real O6 tokens
bridge/                   NEW  Phase 2
  server.mjs                   hook receiver + SSE + static office
  transcript.mjs               tail transcript JSONL for real usage
  map-claude-code.mjs          hook payload → OfficeEvent
  hooks/settings-snippet.json  what the user pastes into .claude/settings.json
fixtures/
  recorded-lead-run.json  NEW  committed demo run
  recorded-coding-run.json NEW committed demo run
public/office.png         DELETE (−1.6 MB)
```

## The event contract (the seam that makes both phases work)

One versioned envelope every producer emits and the renderer consumes:

```ts
type OfficeEvent = {
  v: 1
  id: string; ts: number; runId: string
  source: 'lead-workflow' | 'claude-code'
  type:
    | 'run.started' | 'run.finished'
    | 'work.received'                    // something lands in the inbox
    | 'assignment.started' | 'assignment.finished' | 'assignment.failed'
    | 'specialist.joined' | 'specialist.left'   // subagent spawn / despawn
    | 'handoff'                          // folder moves desk A → desk B
    | 'artifact.created'
    | 'review.requested' | 'review.resolved'
    | 'blocked'
    | 'usage.reported'                   // always carries its source
  actor?:   { id: string; desk: string; kind: 'permanent' | 'specialist'; role?: string }
  subject?: { id: string; label: string }   // the lead / the file / the unit of work
  label: string        // the literal human-readable action
  detail?: string
  payload?: unknown
}
```

Claude Code mapping: `SessionStart`→`run.started`, `UserPromptSubmit`→`work.received`, `SubagentStart`→`specialist.joined`, `PreToolUse`→`assignment.started` (desk chosen by tool category), `PostToolUse`→`assignment.finished` (+`artifact.created` for Write/Edit), `PostToolUseFailure`→`assignment.failed`, `PermissionRequest`→`review.requested`, `SubagentStop`→`specialist.left`, `Stop`→`run.finished`, transcript tail→`usage.reported`.

## Key flows

1. **Watch the sample.** Load → click Run sample → work lands in the inbox → folders travel desk to desk → held/excluded leads visibly leave the line with a stated reason → two drafts reach the outbox → open the review packet.
2. **The intern.** A bounded assignment spawns a specialist: a figure walks in the door, takes a hot desk, the meter attributes tokens to them, they finish and leave.
3. **Work comes back.** A review fails: the folder is carried *backward* to the previous desk with the specific revision reason attached.
4. **Inspect.** Click a desk → zoom in, see the assignment, tools used, event trail, and outputs. Click a folder → follow that one unit of work end to end.
5. **Replay.** A finished run serializes to an event array; scrub, pause, change speed. The committed fixture plays on load, marked "recorded run."
6. **Connect Claude Code.** `npx o6-office bridge` → paste the printed hook block into `.claude/settings.json` → open the printed localhost URL → run Claude Code → watch your own session render, including subagents arriving and leaving.

## Config surface

Names only. `O6_BRIDGE_PORT`, `O6_BRIDGE_TOKEN` (bridge auth), `O6_TRANSCRIPT_POLL_MS`, `O6_MAX_EVENTS`. Model keys stay browser-held and BYOK exactly as today — never written to the repo, hosting metadata, or a client bundle.

## Testing strategy

| Kind | What | Command |
|---|---|---|
| Unit | Contract validation, iso projection + depth sort, clock seek/pause determinism, tool→desk mapping, transcript usage parsing | `node --experimental-strip-types --test tests/*.test.mjs` |
| Integration | Fixture event stream → scene state produces the expected desk/worker/folder positions at given clock times; a burst of 5 simultaneous events preserves stream order | same |
| Regression | Existing lead-engine + API tests must stay green (20 currently pass) | same |
| Smoke | Bridge accepts a synthetic hook POST and emits a well-formed SSE event | `node bridge/smoke.mjs` |
| Browser | Load the app, run the sample, screenshot the office mid-run, confirm no console errors, check mobile width | preview tools |

Gate before any merge: `npm run build`, `npx tsc --noEmit`, `npm run lint`, tests green, new behavior has a test, smoke clean.

## Execution phases

**Phase 1 — the live office** (sequential; each builds on the last)
- **T001** Event contract + floor-plan schema + lead floor plan. Pure types and data; no UI.
- **T002** Renderer: iso projection, sim clock, scene reducer, SVG parts, replay controls. Developed against a hand-written fixture so it is provable without the workflow.
- **T003** Port `use-office.ts` to emit `OfficeEvent`. Keep `lead-engine.ts` untouched. Existing tests stay green.
- **T004** Wire into `app/page.tsx`, delete the PNG, rebuild `office.css` on real O6 tokens, inspection panel, record and commit the demo fixture.

*Checkpoint: review the live office before Phase 2.*

**Phase 2 — connect your work**
- **T005** Bridge: hook receiver, SSE, static serve, transcript tailer for real usage.
- **T006** Claude Code mapping + coding floor plan + the settings snippet.
- **T007** DX: `npx` entry, README rewrite, committed coding-session fixture.

**T008 — Anthropic provider** (parallel with Phase 2; touches only `app/api/agent/route.ts`, the settings dialog, and its tests)

T001→T002→T003→T004 are sequential (each consumes the previous). T005 and T006 touch disjoint files and can run in parallel once T001 lands. T008 shares no files with Phase 2 and can run alongside it.

## Verification

End to end, not just tests:
1. `npm run dev`, load the app, click **Run sample**, screenshot the office mid-run with a specialist present and a folder in transit.
2. Scrub the replay backward and forward; confirm positions are deterministic at the same clock value.
3. Check console for errors and the network panel for failed requests.
4. Resize to mobile width and confirm the office stays readable.
5. Phase 2: start the bridge, add the hooks to a scratch project, run a real Claude Code session that spawns a subagent, and confirm the specialist appears and leaves, with usage attributed from the transcript.

## Decisions taken

- **Provider:** add Anthropic **alongside** OpenAI as a selectable provider, reusing the existing validating server proxy, structured-output schema, and exact-source-quote checks in `app/api/agent/route.ts`. OpenAI path stays working. → **T008**, independent of T001–T004, so it can run in parallel with Phase 2.
- **Palette:** adopt the authoritative O6 tokens. Violet ≤5%, reserved for live activity only. Applies to the whole app, not just the office — `app/office.css` and `app/globals.css` both get rebuilt on the real tokens in T004.

---

## Architecture review — adopted amendments (2026-09-06)

An independent architecture review was commissioned during planning and briefed cold. It confirmed
the core calls (inline SVG, simulation clock decoupled from wall-clock, imperative mutation outside
React, floor-plan-as-data, and — reached independently — the bridge serving the office UI on its own
origin to avoid the https→localhost mixed-content problem). The following amendments are **adopted**
and supersede the corresponding parts of the sections above.

### A1 — Replay is the primary system; live is replay played at its head

Motion compiles to explicit tracks (`{ startMs, endMs, from, to, easing }`) and `sampleAt(t)` is a
pure lookup. Pause, scrub, speed and rewind then become *the same code path* instead of four separate
problems. Live mode appends to the same timeline and tracks wall-clock at its head. This makes replay
quality structural rather than a matter of discipline — which matters, because the recorded run is the
public demo.

Non-positional state (a worker's status label, outbox count, folder ownership) are **step channels**
(piecewise-constant), so scrubbing to an arbitrary `t` yields the correct label with no replay from zero.

### A2 — Pre-compiled depth bands, not per-frame sorting

Re-sorting SVG children every frame via `appendChild` invalidates the render tree — that is the real
SVG performance cliff, worse than node count. Instead `compileFloorPlan()` emits fixed ordered band
containers, each desk contributing `desk-back` / `desk-seat` / `desk-front` slots. A seated worker in
`desk-seat` is clipped by the `desk-front` polygon; that single trick carries most of the depth read.
Walking actors are re-parented only when they cross a band boundary, not per frame.

`compileFloorPlan` validates that every aisle edge is depth-monotonic and warns loudly in dev — the
floor plan solves occlusion, the renderer does not need a general solver.

### A3 — Honesty invariants as assertions, not prose

Written as runtime assertions in the scheduler:

- **I1 Order** — for the same entity, A completes before B begins (per-entity cursors, not one global cursor).
- **I2 No invention** — never play a transition without an event for it. Unexplained position changes *cut*; they do not walk. A cut is an honest ellipsis, a walk is a claim.
- **I3 No reordering** — compression scales time; aggregation may collapse *concurrent* events, never *sequential* ones.
- **I4 Visible compression** — whenever rate ≠ 1 or aggregation is active, the UI says so (`×2.4 · 12 batched`).
- **I5 Arrival ≠ occurrence** — events carry both `occurredAt` and `receivedAt`; scheduling orders by `occurredAt`. **Five parallel tool calls landing in the same millisecond are genuinely simultaneous; a FIFO queue would serialise them into an ordering that never happened.** Simultaneous events schedule into parallel lanes.

Backpressure is measured as scheduled-time debt (`timelineHead − simTime`), in three tiers: real time
(<1.5s), uniform compression (1.5–6s), summarise into one aggregate move with a count badge (≥6s or a
large burst). **Nothing is ever dropped — the floor is a lossy view; the panel and exported log stay
lossless.**

### A4 — Art-direction guards

- **The camera must not chase the action.** Auto-panning to whatever is hot is the strongest "this is a game" signal. Fixed camera by default; attention is signalled by a soft light-pool on the active room. Camera moves only on explicit user click.
- **No SVG filters in the actor layer** (`feDropShadow`, `feGaussianBlur`). Filters are what actually kill SVG on mobile. Shadows are pre-computed polygons with flat fills in the static layer.
- **Labels are HTML in an overlay layer, not SVG `<text>`**, so they inherit the existing Tailwind/shadcn type system, wrapping and truncation.
- Above ~4 concurrent items on a shared aisle segment, render one cart with a count badge that splits at the destination. This protects the art direction and must exist from day one, not be retrofitted.
- Deterministic jitter from `hash(eventId)` staggers simultaneous movers — perfect lockstep reads as a rendering glitch.

### A5 — Determinism is a set of bans, and it is testable for free

No `Math.random` (seeded `mulberry32` from the run id; per-entity jitter hashed from the event id, not
sequential draws). No `Date.now()` inside the scene — only `simTime`. Hot-desk and lane assignment keyed
by `seq`, never arrival order.

Because SVG serialises to a string, the determinism test is free:
`hash(renderSceneToString(plan, events, t))` over a fixed grid of `t`, compared across two runs and
across live-capture vs replay. This becomes the primary regression test for T002.

### A6 — Accessibility is on-thesis, not a checkbox

The product's premise is making agentic work legible. A screen-reader-navigable office where each desk
announces its current assignment *is the product*, not an accommodation bolted onto it. A parallel
semantic outline (rooms → desks → current task) ships in T002, not "later".

### A7 — Module boundary enforced by lint

The renderer must not know what a "lead" or "Claude Code" is; it knows `FloorPlan`, `OfficeEvent`,
`Theme`. Enforced with oxlint `no-restricted-imports` (oxlint already runs): `core/` imports nothing;
`react/` imports `core/` + react; `adapters/` imports `core/types` only; nothing under `office-view/`
may import `@/lib/lead-engine`, `@/app/*`, or `@/components/ui/*`.

Also: `vinext` is RSC-based. Floor plans are static JSON imported in a server component and passed as a
prop; only `OfficeView` is `'use client'`.

### A8 — Mobile switches plan variant, not just zoom

Plans declare a `compact` arrangement (fewer rooms, stacked vertically). It is data, so it costs nothing.
Below ~640px show only the selected/active label and collapse the rest to dots — label soup at small
sizes is what destroys the diorama read. `hooks/use-mobile.ts` already exists for the breakpoint.

---

## Corrections to the plan above

The review found three things in the existing code that the plan got wrong or missed. These override
the earlier sections.

### C1 — The flagship beat has no event to fire on (blocking, affects T003 + T004)

**The "reviewer sends work back" moment cannot happen in the shipped demo as the code stands.** In
`lib/use-office.ts`, a rejected draft sets `state='hold'`, logs a warning, and sets `processed=true` —
there is no edge back to Outreach. And in local-rules mode, which is the default public demo path with
no API key, Review *always* completes. So the single most memorable animation would never appear.

This must not be solved by fabricating a rework loop for the sake of a pretty animation (that violates
I2). Two honest options, decided in T003:

1. **Make the rework edge real** — a held draft genuinely returns to Outreach for one retry carrying the
   reviewer's specific reason, and the retry genuinely re-runs. Requires a local-mode check that can
   genuinely fail (e.g. a draft asserting something absent from the evidence).
2. **Record the demo fixture from a real live-AI run** in which a reviewer actually rejected a draft,
   labelled "recorded run — live AI".

Option 2 is honest with no code change; option 1 makes the beat reachable in the default path. Prefer
doing both: implement the real rework edge, and record the fixture from a run where it genuinely fired.

### C2 — `WorkEvent` has no `from` (affects T001 + T003)

`move()` in `use-office.ts` logs a `started` event *at the destination only*. There is no source
department, so handoff edges must be synthesised by tracking each lead's previous department in the
adapter. Cheap, but easy to miss. Consequently `direction: 'forward' | 'backward'` is **explicit in the
contract**, never inferred from "the destination happens to be upstream" — the carried-backward beat has
its own path, pacing and label, and both producers must be able to state it.

### C3 — `toggleSpeed` currently speeds up the work, not the playback (affects T003)

`toggleSpeed` divides the `await wait(...)` that paces the workflow itself. In the new model speed is
strictly a **playback** control. The two meanings must not share a variable: in live mode the same
control becomes a catch-up-rate ceiling owned by the scheduler.

Also: `active` (`Record<leadId, Department>`) becomes redundant once who-is-where is derived from the
event log. Delete it rather than maintaining two sources of truth. And the existing shadcn `Sheet` in
`app/page.tsx` already handles both `selectedLead` and `desk`, so the inspection panel in T004 is mostly
wiring.

### C4 — De-risk the adapter early without reordering the build

The review's top risk is that **most product risk lives in the Claude Code adapter, not the renderer**:
forty `Read` calls in three seconds is not forty folder trips, and if aggregation is an afterthought the
demo either seizures or quietly lies.

Rather than reordering the agreed phases, T001 additionally **captures a real Claude Code session's hook
stream to a fixture**. T002 then develops the renderer against both a lead fixture and a real coding
fixture, so burst behaviour is proven against real data long before the bridge exists. This kills the
top risk at near-zero cost and keeps the office-first order.

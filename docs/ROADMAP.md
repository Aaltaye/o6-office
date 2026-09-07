# Roadmap

Where this goes next, and — as importantly — where it deliberately does not.

Some of what follows was prompted by looking at [ajsahni/agents-office](https://github.com/ajsahni/agents-office),
a 3D isometric office where AI agents actually execute tasks routed through a folder of
Markdown notes. It is a different product with a different thesis: it is an environment for
*doing* work, where the office is the interface. This project is a renderer for work that
*already happened*, where the office is the evidence. Several of its ideas transfer cleanly;
a few would quietly cost the thing that makes this project worth building. Both lists are
below, because the second one is the more useful of the two.

---

## The line this project will not cross

Every item here is measured against the same rule: **what you see is what happened.** A
feature that makes the office more impressive by asserting something the events do not
support is a net loss, however good the demo.

Three ideas were considered and declined on exactly that basis.

**Agents that select themselves and execute the work.** This would collapse the seam the
whole architecture rests on — producers emit `OfficeEvent`s and know nothing about pixels;
renderers consume them and know nothing about agents. The moment the office runs the work,
it stops being a neutral view of it, and "what you see is what happened" becomes
unfalsifiable because the office is also the thing doing the happening.

**A statically populated office — a fixed roster of agents at fixed desks.** Only what is
actually live goes on the floor. One agent means one figure; six subagents means six. A
populated office is more impressive in a screenshot and less true every second after.

**Chatting with an agent in its professional role.** Tempting, and the underlying need is
real, but a conversational persona means inventing a voice and an intent for something that
only ever produced tool calls. Labels here are literal or they are nothing. The honest
version of this need is item 2 below.

---

## Status

All seven shipped. What follows is kept as the record of what was built and why, including
the three ideas that were considered and declined — that list is the more useful half, and
it is the one worth re-reading before adding anything.

---

## Ranked

### 1. Presentation mode — *done*

One keypress hides the chrome, fixes the camera, and plays a run cleanly, with the
compression stamp still legible in frame.

The README GIFs in this repo were produced by hand-driving the `/lab` scrub through a local
frame receiver and compositing the HTML label overlay onto the canvas — about an hour of
scaffolding that was thrown away afterwards. A product whose entire pitch is "watch this"
should be able to produce its own footage. This also makes the office demonstrable in a
meeting without a browser full of dev controls.

Deterministic by construction: it drives `seekMs` rather than wall-clock playback, so the
same run produces the same frames every time.

### 2. Click a person — *done*

You cannot currently select a worker on any surface that ships. `Selection` has a `worker`
kind, and the SVG outline uses it, but the three.js `pickables` array contains only desk
meshes, so on the landing page, `/office` and the live bridge, clicking a person does
nothing.

This is the honest half of "chat with an agent": not a persona, a **dossier**. Who they are
(`main`, or `agent:<id>` with the role from its own `meta.json`), every assignment they
actually ran, where they have been — the `stationAt` channel already carries this — and
their own token burn, which `transcript.mjs` already resolves per subagent and nothing has
ever displayed. All of it is already in the timeline. None of it is currently reachable.

### 3. What the run produced — *done*

The office shows process and never output. `artifact.created` is emitted, carries
`{id, name, kind}`, and is rendered nowhere: a run can write forty files and the office will
show forty moments of writing and no list of what exists at the end.

An artifacts panel — what was produced, by which desk, at what point, filtered by the
current selection like the operations log — is the analogue of a notes "Brain", built from
events we already have rather than a parallel store. It answers the question a viewer asks
immediately after "what happened": *so what came out of it?*

### 4. Keyboard control — *done*

Number keys jump to a department; `space` plays and pauses; `←`/`→` scrub; `R` toggles the
renderer; `Esc` clears the selection.

The accessibility outline already provides a complete keyboard path through the office, so
this is not an access fix — it is a fluency one. It is also what makes the thing usable
while presenting, which pairs with item 1.

### 5. One config file — *done*

`office.config.json`: which floor plan, which port, which model, the brand name, the
compression thresholds currently sitting in `DEFAULT_OPTIONS`.

Configuration today is split between environment variables the bridge reads, constants in
`scheduler.ts`, and literals in page components. Anyone forking this to watch their own
agents has to edit source to change the port or the office's name.

### 6. `npm run check` — *done*

One command for the whole gate: build, typecheck, lint, test. It is four commands today and
they get run in the wrong order or not at all.

### 7. Dark mode — *done*

`globals.css` already defines a `.dark` token set from the original scaffold; nothing
toggles it, and the office's own stylesheet does not respond to it. The renderer's palette
is a deliberate near-monochrome with violet reserved for live activity, so a dark variant
needs the same discipline applied to a dark ground rather than an inversion — which is why
this is last despite being easy.

---

## Not planned, and why

A **board view** of work in flight was considered and folded into item 3 instead. For a
coding session the unit of work is the turn, and a board of one column is not a board. The
lead workflow does have real units moving between desks, but it already shows them moving,
which is the better answer.

**Agent meetings** would need real multi-agent coordination events in the contract. There
are none, and inventing them to draw a meeting would be exactly the kind of scene this
project exists not to draw.


---

## What shipped, in one place

`P` presents (chrome gone, floor and compression stamp only). Clicking a person opens a
dossier built from what they did — stated role, assignments, desks used, their own attributed
tokens, and "not reported" where the stream never said. A **Produced** tab lists what a run
made, from `artifact.created`; it does not filter by person, because an artifact records the
desk it was made at and not who made it, and the panel says so rather than guessing.
`space`, `←`/`→`, `1`–`6`, `R`, `D` and `Esc` drive the rest. `office.config.json` layers
under `office.config.local.json` under `O6_*` environment variables, and rejects nonsense
from any of them. `npm run check` is the whole gate.

Dark mode covers the chrome only. The renderer keeps its palette on purpose: the office is a
lit room, and a room does not invert when you darken the page. `/office/leads` is older
markup with `#fff` written into it in dozens of places and stays light until that is unpicked.

---

## Vendoring from the sibling library — audited, and declined

`bridge/office-config.mjs` credits "the pattern this codebase's sibling library settles
on", which raised a fair question: if a real, tested implementation of that already exists,
why is there a hand-rolled one here? Six candidates from that library were audited against
this repo — a config loader, a screenshot helper, a cost tracker, an SSE helper, a PII
redactor and a command parser — for whether they are safe to publish under MIT, what they
would drag in, and whether o6-office would actually use them.

**All six came back "do not vendor", and none of them for licensing reasons.** The code is
clean; it simply does not fit, and four of the six would have made this repo worse:

- The config loader cannot express nested environment overrides (`O6_BRIDGE_PORT` →
  `bridge.port`), and it turns two deliberately-silent fallbacks into crashes on the hook
  path — a typo in a shell profile would kill the bridge instead of being ignored. It also
  needs a schema library, on a path that is dependency-free on purpose.
- The SSE helper models one subscriber with no history; the bridge is a broadcast hub with
  replay, on `node:http` rather than the fetch API. It would displace about twelve lines.
- The PII redactor finds nothing here — measured, not assumed: it detects zero matches
  across every committed fixture. The capture script already redacts by structural
  allowlist, which is stronger than pattern-matching for the thing that actually leaks out
  of a transcript.
- The screenshot helper takes a URL and returns a PNG, and the frame worth photographing
  here is not reachable from a URL.

The rule this settles on: **a public repo carrying unused code is worse than a public repo
without it.** Vendoring is not free even when the code is good and the licence is yours.

One genuine defect came out of the audit and was fixed rather than vendored: the cost
estimate priced Anthropic cache tokens at the plain input rate, which under-stated a cache
write's 1.25x premium and so quietly broke the "upper bound" the docstring promises. Four
numbers and a parameter, with a regression test — not 355 lines and a tokenizer.

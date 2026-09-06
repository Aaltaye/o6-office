# O6 Office

**Make invisible work visible.** Agentic work rendered as a miniature office you watch
from above — desks, folders, handoffs, and a specialist called in for a bounded job — so
that what an agent is actually doing is legible to someone who has never read a log.

O6 Invention Lab, Experiment 001.

Two modes, one renderer:

| Mode | What it is |
|---|---|
| **Run your work** | A lead-reactivation workflow. Give it a CSV of old enquiries and watch the office work out which conversations are worth reopening, and why. |
| **Connect your work** | A local bridge streams your own Claude Code session into the same office. Your session never leaves the machine. |

Both produce the same versioned event contract. The renderer consumes only that, and
knows nothing about leads or about Claude Code.

---

## Run it

Node 22.13+.

```sh
npm ci
npm run dev          # the product, at the printed URL
```

```sh
npm run build
npx tsc --noEmit
npm run lint
npm test
```

Other entry points:

- **`/lab`** — a development harness for the renderer, with synthetic streams (including a
  six-wide burst) plus play, pause, scrub, speed and a compact-plan toggle.
- **`npm run bridge`** — the local bridge, below.

---

## Connect your Claude Code session

```sh
npm run build:bridge   # once, to build the office page the bridge serves
npm run bridge
```

The bridge prints two things: the path to a ready-to-paste hooks file, and a URL. Merge
the hooks into `.claude/settings.json`, open the URL, and use Claude Code as normal.

It binds to `127.0.0.1` only, requires a token, and refuses to start without one. It
serves the office page itself, on its own origin, so there is no CORS and no
mixed-content problem — and no session data crosses the network.

What the office shows:

| In your session | On the floor |
|---|---|
| A prompt | Work arrives in the inbox |
| A tool call | The agent walks to that desk and starts an assignment |
| An edit or write | A document appears, which you can open |
| A tool failure | The assignment fails, carrying the tool's own error |
| A subagent spawns | Someone walks in through the door |
| A permission prompt | An approval lands on the manager's desk |
| Tokens | A meter, read from the session transcript |

**The office shows whatever is actually live.** Nobody is on the floor who is not
running: one agent means one figure, six subagents means six. There is no fixed roster
and no capacity cap — the cast comes from the stream.

`bridge/hooks/settings-snippet.json` is a reference copy whose token comes from
`$O6_BRIDGE_TOKEN`. The file the CLI writes contains your real token and is gitignored.

---

## The rules this thing follows

The product's whole claim is that what you see is what happened, so these are enforced in
code rather than written down and hoped for — they live as runtime assertions in
`lib/office-view/core/scheduler.ts`.

- **Labels are literal.** "Reviewing draft against source notes", or a tool's own name and
  file. Never an invented account of what an agent was thinking.
- **Nothing is animated that did not happen.** If a position changes with no event to
  justify a journey, it cuts rather than walks. A cut is an honest ellipsis; a walk is a
  claim.
- **Simultaneous stays simultaneous.** Parallel tool calls are concurrent, and a queue
  would show a sequence that never occurred.
- **Compression is stated.** When time is compressed or items are batched, the office says
  so on screen. A compromise said out loud is information rather than a lie.
- **Usage cites its source, and "unavailable" is a real answer.** Local-rules mode reports
  no tokens because it spent none; a confident zero would read as "this was free".
- **Sample, live and recorded are always labelled.**

Violet means one thing only: work happening right now. That is also how the office stays
inside the O6 brand's 5% cap on violet — by construction rather than by vigilance.

---

## Where things are

```
lib/office-view/        the renderer — extractable, knows nothing about the domain
  core/                 contract, projection, timeline, scheduler (no React, no DOM)
  react/                the SVG office and its animation loop
  art/                  theme and sprites
lib/floorplans/         one plan per kind of office; plans are data, not code
lib/lead-engine.ts      CSV parsing, dedup and qualification rules
lib/lead-workflow.ts    the lead workflow, with no React in it
lib/lead-review.ts      the local reviewer and the grounded redraft
bridge/                 the local bridge: server, hook mapping, transcript reader, CLI
fixtures/               recorded runs, and one captured real session
scripts/                capture, record and replay tools
tests/                  the honesty tests
```

`npm test` runs everything.

---

## Scope and limitations

Stated plainly, because a demo that overstates itself is the exact failure this project
exists to avoid.

- A working prototype, not a hosted multi-tenant product. No accounts, no server-side
  storage. Runs live in memory; export before you refresh.
- **No messages are ever sent.** Approving a draft marks a record. That is all.
- The lead workflow does no external enrichment and no web research. "Research" here means
  tracing claims back to the records you supplied.
- Readiness rules are conservative heuristics, not a predictive model. Unknown flags,
  invalid dates and ambiguous records are held rather than guessed at.
- Live-AI mode uses your own API key, held in browser memory and sent over the site's own
  HTTPS connection to its own server, then to the provider. It is never persisted or
  logged here. Usage is counted from completed responses, so failed or aborted calls may
  cost money that is not reported.
- Only Claude Code has a bridge adapter. Codex and Replit do not.
- `fixtures/captured-coding-session.json` is a **reconstruction** from session transcripts
  already on disk, not a live hook capture. Its timings, tool order, failures and subagent
  are real; its content is redacted. The file says so in its own `derivation` field.
- The burst fixture in `/lab` is **synthetic** and labelled so. The real captured session
  contains little parallelism, so it demonstrates pacing rather than burst handling.
- The renderer is designed to be extractable as a standalone package, but is not published
  as one.
- No open-source licence has been chosen. Choose one before publishing this repository.

# Connect your agent to the office

You want to watch your own agent work. This page has two things: the short human version,
and a prompt you can hand to your coding agent so it does the wiring for you. You do not
need to clone anything.

The office renders **one event contract**. Claude Code gets a zero-code path because its
hooks map onto that contract directly. Every other agent — Codex, Replit, a loop you wrote
yourself — posts the contract to an endpoint. Both end up in the same office.

Nothing leaves your machine. The bridge binds to `127.0.0.1`, refuses to start without a
token, and the token is written to a gitignored file.

---

## The short human version

In the project you want to watch:

```bash
npx github:Aaltaye/o6-office setup
```

It tells you what it is about to do, wires the hooks into that project's
`.claude/settings.json`, starts the bridge, and then **verifies the connection** — it
pushes an event through the same path a real hook takes and waits for it to come back out
of the stream the office reads. If that fails it says so plainly rather than pretending you
are set up, because the alternative is you finding out later from an empty office.

It keeps every setting and every hook you already had, backs the file up first, and is safe
to run twice — a second run tells you that you were already wired rather than doing it
again. `--yes` skips the prompt; `--port` moves it if 4141 is taken.

The two halves are still available on their own: `o6-office connect` writes the hooks (with
`--dry-run` to see what it would do and change nothing), and `o6-office` runs the bridge.

Not using Claude Code? One command reports an event, so anything that can run a shell
command can drive the office:

```bash
npx github:Aaltaye/o6-office emit assignment.started "Reading the spec" --desk reading
```

Nothing leaves your machine. The bridge binds to `127.0.0.1`, refuses to start without a
token, and writes that token to a gitignored file.

---

## The prompt

Paste everything in the box below into Claude Code, Codex, Replit's agent, or whatever you
use, from the project you want to watch.

---

> **o6-office** renders agentic work as a watchable office — desks, handoffs, a subagent
> called in for one job. I want to connect **your** session to it so I can watch you work.
>
> Do this:
>
> **1. Start the bridge**, in its own terminal, and leave it running:
>
> ```bash
> npx github:Aaltaye/o6-office
> ```
>
> It binds to `127.0.0.1:4141`, generates a token if there isn't one, and prints a URL.
> If port 4141 is taken, add `--port <n>` and use that port everywhere below. (If you are
> working inside a clone of the repo, `npm run bridge` does the same thing.)
>
> **2. Work out which path applies to you, and say which one you picked.**
>
> *If you are Claude Code:* run `o6-office connect` in the project I want to watch. It
> merges the hooks into `.claude/settings.json`, keeping everything already there, and
> backs the file up. Run it with `--dry-run` first if you want to show me the change.
> Never commit the token: `.o6-office-hooks.json` is gitignored, `.claude/settings.json`
> may not be, so if wiring it up would write a token into a tracked file, tell me instead.
>
> *If you are any other agent* (Codex, Replit, a custom loop): you have no hook system, so
> report events yourself. The easy way is one shell command per event, which needs no HTTP
> client and no SDK:
>
> ```bash
> o6-office emit assignment.started "Reading the spec" --desk reading
> o6-office emit artifact.created "Wrote report.md" --desk workshop
> o6-office emit run.finished "Session ends"
> ```
>
> If you would rather speak HTTP directly, `POST` the contract to
> `http://127.0.0.1:4141/event` with the header `x-o6-token: <token>` — one event or an
> array. It replies with `{ok, events, rejected}` and says *why* anything was rejected;
> read that rather than guessing.
>
> **3. Emit events as you work.** Minimum useful set:
>
> | when | send |
> |---|---|
> | you start | `{"type":"run.started","label":"Session opens"}` |
> | you get a task | `{"type":"work.received","label":"<the request, briefly>"}` |
> | before a tool call | `{"type":"assignment.started","label":"<literal action>","station":"<desk>"}` |
> | after it succeeds | `{"type":"assignment.finished","label":"<tool name>","station":"<desk>"}` |
> | after it fails | `{"type":"assignment.failed","label":"<what failed>","station":"<desk>"}` |
> | you write a file | `{"type":"artifact.created","label":"Edited <file>","station":"workshop"}` |
> | you spawn a subagent | `{"type":"specialist.joined","label":"A subagent joins","worker":"agent:<id>"}` |
> | it finishes | `{"type":"specialist.left","label":"Subagent finished","worker":"agent:<id>"}` |
> | you stop | `{"type":"run.finished","label":"Session ends"}` |
>
> `label` is required on every event and is what a person reads on the desk.
>
> **Desks** (`station`) are: `frontdesk` (planning, delegation), `reading` (reading and
> searching files), `research` (web, browsing), `operations` (shell, processes),
> `workshop` (writing and editing files), `approvals` (asking me something). Pick the one
> that matches what you are actually doing. If none fits, use `frontdesk` — it is the
> stated default for unrecognised work.
>
> **4. Open the office** at the URL the bridge printed and confirm you can see yourself:
> a desk should light up when you use a tool, with your literal action on it. Then tell me
> what you saw. If nothing appears, check `GET /health` — it reports `events`, `clients`,
> `watching` and `malformed` — and report what it says rather than assuming it worked.
>
> **The rules this office runs on, which your events must respect:**
>
> - **Labels are literal.** "Reading src/app.ts", or the tool's own name. Never an invented
>   account of what you were thinking. No "considering the best approach".
> - **Only send events for things that actually happened.** Do not pre-announce work you
>   are about to do, and do not emit a `finished` you did not observe.
> - **Simultaneous work is simultaneous.** If you make three tool calls in parallel, send
>   three events with the same timestamp. Do not serialise them into an order that did not
>   occur.
> - **Don't invent tokens.** Usage is read from a transcript, not estimated. If you cannot
>   report real usage, report none — a confident zero reads as "this was free".
>
> The whole point of this thing is that what someone watches is what actually happened. An
> event that makes the office look busier than the work really was defeats it entirely.

---

## Reference

**Endpoints** (all require `x-o6-token`, all loopback-only):

| endpoint | method | what |
|---|---|---|
| `/hook` | POST | a Claude Code hook payload, translated into the contract |
| `/event` | POST | one contract event, or an array of them (`o6-office emit` wraps this) |
| `/events` | GET | the SSE stream the office reads, replaying what happened so far |
| `/health` | GET | `events`, `clients`, `watching`, `malformed` |

**Token.** Generated on first run and written to `.o6-office-hooks.json`, which is
gitignored. Set `O6_BRIDGE_TOKEN` to choose your own. The bridge will not start without
one — an unauthenticated local port is reachable by anything else on the machine.

**Token usage** is read from the Claude Code transcript when a hook supplies
`transcript_path`, including per-subagent attribution. Other agents get no usage figures,
and the office says so rather than showing zero.

**The contract itself** is `lib/office-view/core/types.ts`. It is the seam the whole
product hangs on: producers only emit it, renderers only consume it, and neither knows the
other exists.

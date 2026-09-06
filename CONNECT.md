# Connect your agent to the office

You cloned this repo and you want to watch your own agent work in it. This page has two
things: the short human version, and a prompt you can hand to your coding agent so it does
the wiring for you.

The office renders **one event contract**. Claude Code gets a zero-code path because its
hooks map onto that contract directly. Every other agent — Codex, Replit, a loop you wrote
yourself — posts the contract to an endpoint. Both end up in the same office.

Nothing leaves your machine. The bridge binds to `127.0.0.1`, refuses to start without a
token, and the token is written to a gitignored file.

---

## The short human version

```bash
npm install && npm run bridge
```

It prints a hook block to paste and a URL to open. Use your agent as normal; the office
follows along.

---

## The prompt

Paste everything in the box below into Claude Code, Codex, Replit's agent, or whatever you
use, from the root of this repo.

---

> You are working in a cloned copy of **o6-office**, which renders agentic work as a
> watchable 3D office. I want to connect **your** session to it so I can watch you work.
>
> Do this:
>
> **1. Start the bridge.**
> Run `npm install` if `node_modules` is missing, then start the bridge with
> `npm run bridge`. It binds to `127.0.0.1:4141`, generates a token if there isn't one, and
> prints both a hook block and a URL. Leave it running. If port 4141 is taken, use
> `npm run bridge -- --port <n>` and use that port everywhere below.
>
> **2. Work out which path applies to you, and say which one you picked.**
>
> *If you are Claude Code:* you have hooks, so this needs no code. The bridge wrote
> `.o6-office-hooks.json` in this repo — it contains the real token. **Merge its `hooks`
> object into `.claude/settings.json`** (project-level is fine). Merge, do not overwrite:
> if that file already exists, preserve every key already in it, and preserve any existing
> hooks for other tools. Never commit the token; `.o6-office-hooks.json` is gitignored and
> `.claude/settings.json` may not be, so if you write the token into a tracked file, tell
> me instead of doing it.
>
> *If you are any other agent* (Codex, Replit, a custom loop): you have no hook system, so
> emit the contract directly. `POST` JSON to `http://127.0.0.1:4141/event` with the header
> `x-o6-token: <token>`, where the token is in `.o6-office-hooks.json`. Send one event or an
> array. The endpoint replies with `{ok, events, rejected}` and tells you *why* anything was
> rejected — read that rather than guessing.
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
| `/event` | POST | one contract event, or an array of them |
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

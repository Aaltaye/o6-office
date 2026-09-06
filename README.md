# O6 Office

Lead Reactivation Office — O6 Applied / Invention Lab / Experiment 001.

## Run locally

Requires Node.js 22.13+ and npm. Open a terminal in this folder:

```sh
npm ci
npm run dev
```

Use the URL printed by the server (normally http://localhost:3000; another port is chosen when busy). The original build session used http://localhost:3001.

```sh
npm run build
npx tsc --noEmit
node --experimental-strip-types --test tests/*.test.mjs
```

## Where to edit

- `app/page.tsx`: office, lead workspace, activity trail, import/settings dialogs, draft review panel.
- `app/office.css`: visual styling and responsive layout.
- `app/globals.css`: shared theme tokens.
- `lib/use-office.ts`: two concurrent lead workers, department events, stop behavior, AI assignments.
- `lib/lead-engine.ts`: CSV parser, fictional dataset, merge rules, qualification, template drafts, exports.
- `app/api/agent/route.ts`: server proxy for the three OpenAI assignments, schema and evidence checks.
- `public/office.png`: generated office illustration. Labels and moving lead-file indicators are live UI overlays.
- `tests/`: meaningful lead-rule and mocked API contract tests.
- `.openai/hosting.json`: the existing private Sites project. Reuse its project ID; do not create a duplicate site.

## Try it

1. Click **Run sample**. The 10 fictional records become 9 unique leads: 2 ready, 5 held, 2 excluded.
2. Click a desk for activity, or a lead-file indicator to follow that lead.
3. Open **Lead workspace**, inspect a lead, edit its draft, and mark it reviewed or hold it.
4. Export CSV for a spreadsheet or the full JSON packet for source records, events, and usage.
5. Import your own CSV (25 rows / 250 KB maximum), describe your offer in Settings, and run again.

### Two execution modes

**Local:** The default uses real deterministic data processing and template drafts. It makes no model calls and reports zero tokens and cost. Built-in sample uses the fixed date 2026-09-06; imported data uses the current UTC date.

**Live AI:** Add an OpenAI API key in Settings. Context, Outreach, and Review run separate, bounded GPT-4.1 mini calls for eligible leads, with structured output and exact source-quote validation. Two leads may process concurrently. The server sends requests only to https://api.openai.com/v1/responses, with `store:false`. The key is held in browser memory, sent over the site's HTTPS connection to its server, then to OpenAI. This app does not persist or log the key or records. Provider-side data handling follows the user's OpenAI account policies. API billing applies.

No server environment key is required. Do not hardcode a key in source, a URL, client bundle, or hosting metadata.

Usage is based on completed successful responses. Failed or aborted calls may incur unreported cost. Estimates use GPT-4.1 mini input/cached/output prices of $0.40/$0.10/$1.60 per million tokens, verified September 6, 2026; update if pricing changes.

## Scope and limitations

- This is a working prototype, not a complete hosted multi-tenant SaaS.
- State is tab-local, in memory. Export before refresh. Closing the page stops coordination. A fresh run replaces the previous run.
- Research attaches source notes; no external enrichment or web research is performed.
- There are no Claude Code, Codex, Replit, CRM, or email integrations yet.
- No messages are sent. Mark reviewed records a human decision only.
- The 3 AI specialists are separate model calls coordinated by the client. They are not autonomous background employees or dynamically spawning subagents.
- The office image is static. Desk status, file position, metrics, events, and outputs reflect workflow events.
- Readiness rules are conservative prototype heuristics, not a predictive scoring model. Unknown flags, invalid dates, and ambiguous records are held.
- AI-generated personalization can still be wrong despite quote validation and a second model review; inspect the original notes.
- Live API behavior requires the user's key. Automated API tests use mocked responses and do not establish a successful paid live run.
- No broad browser UI QA was requested. Build/type checks and focused automated tests were performed.
- Optional WebMCP tools (`o6_read_run`, `o6_run_sample`) feature-detect `document.modelContext`. No supported WebMCP validation context was available during construction; runtime registration was not verified.

## CSV format

Required: `name,email,notes`. For qualification, include `company,last_contact,next_followup,opted_out,active_customer,stage`.

Dates must be YYYY-MM-DD. Flags accept true/false, yes/no, or 1/0. Missing or unknown flags hold the lead. Duplicate grouping uses trimmed, case-insensitive email only, preserving all notes and the strongest exclusion. Download the fictional CSV in the Import dialog.

## Next development priorities

1. Add resumable server orchestration with authenticated per-user storage.
2. Extract the event contract into a reusable visualization package.
3. Build one actual external adapter (Claude Code hooks or Codex App Server).
4. Add configurable qualification criteria and real CRM imports.
5. Add a budget cap and server-side usage records before larger live workloads.
6. Add browser interaction tests and live-provider integration tests.

No open-source license has been selected; choose one before publishing a repository as open source.

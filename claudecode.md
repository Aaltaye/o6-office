# claudecode.md — O6 Office running log

Context and gotchas for picking this project up cold. **Not** the plan ([PLAN.md](PLAN.md)) and
**not** the task list ([tasks/README.md](tasks/README.md)).

## What this is

O6 Office — Experiment 001 of the O6 Invention Lab, theme *make invisible work visible*. An agentic
workflow rendered as a miniature isometric office you watch from above, so non-technical people can
see what agents actually do. Two intended modes: **run your work** (a built-in lead-reactivation
workflow) and **connect your work** (stream a live Claude Code session into the same office).

## Status timeline

- **2026-09-06** — Prototype inherited from a prior Codex session. Working lead engine, optional live
  GPT-4.1 mini path, CSV import/export, honest labelling. The "office" was a static 1.6 MB PNG with
  six HTML labels positioned at hardcoded percentages — no spatial model, no characters, no motion.
- **2026-09-06** — Relocated from the Codex scratch path to `C:\Users\Altay\Projects\o6-office`.
  Baseline committed as `0d0d970` (84 files). Plan approved; 8 tasks created.

## Conventions

- Local-only git for now: branches, no remote. **The open-source/license decision is unresolved**
  (README notes no license chosen), so nothing is pushed until Abel decides. `gh` is authenticated as
  `Aaltaye` and ready when he does.
- Branch per task: `task/NNN-kebab-title`. Conventional commits. Merge `--no-ff` after the gate.
- Comments are heavy by house rule — this is read cold by other people.

## Gotchas discovered

- **The old Codex folder still holds a lock.** `C:\Users\Altay\Documents\Codex\2026-09-06\are-you-able-to-look-through\work\o6-office` could not be moved ("Device or resource busy") even after killing the dev server, because this session had it registered as a working directory. It was **copied**, not moved; the original remains as a fallback and can be deleted once this repo is trusted.
- **`vinext dev` refuses a second instance** for the same directory and prints the existing PID. If a
  dev server seems stuck, `taskkill /PID <pid> /F` rather than starting another.
- **Do not `cd` into a directory you intend to move** — the Bash tool's working directory persists
  between calls and will hold the lock itself.
- **`robocopy` exits 1 on success** (meaning "files were copied"). Treat exit 1 as a pass; only >= 8 is
  a genuine failure.
- **`grep -c` prints `0` *and* exits 1** when there are no matches, so `$(grep -c ... || echo 0)`
  yields `"0\n0"` and breaks numeric tests. Use `grep -l` or `|| true`.

## Verified facts worth not re-deriving

- **Claude Code hooks** expose `SubagentStart` (with `agent_type` + `agent_id`) as well as
  `SubagentStop`; `Pre`/`PostToolUse` carry `agent_id` when inside a subagent; `PostToolUseFailure`
  carries `tool_error`; `PermissionRequest` is the approval beat; `PostToolBatch` carries a
  `tool_calls` array. Full list checked against the docs 2026-09-06.
- **Token usage is not in any hook payload**, but every hook carries `transcript_path`, and the
  transcript JSONL carries real per-message `usage` (`input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`) plus `model`.
  Verified directly against a local transcript.
- **Per-specialist usage attribution works — but not via `isSidechain`.** Planning guessed subagent
  messages would appear in the parent transcript flagged `isSidechain: true`. They do not; there are
  zero such lines anywhere on this machine, including immediately after a subagent ran. Subagents get
  their own files instead:

  ```
  .claude/projects/<project>/<sessionId>/subagents/
      agent-<agent_id>.jsonl       messages, tool uses, per-message usage
      agent-<agent_id>.meta.json   { agentType, description, toolUseId, spawnDepth }
  ```

  `agent_id` matches what `SubagentStart` delivers, so the join is direct. Verified on a real `Plan`
  subagent: model `claude-opus-5`, tools `Bash`/`Read`, totals 993,117 cache-read / 161,214
  cache-creation / 997 output / 52 thinking tokens.

  `meta.json.description` is the specialist's literal assignment — use it as the desk label; it
  satisfies the no-invented-labels rule for free. `spawnDepth` supports nested subagents. The bridge
  must therefore watch a **directory**, since new `agent-*.jsonl` files appear as specialists spawn.

  Note the background-task `.output` files under `AppData\Local\Temp\claude\...\tasks\` are NOT this
  data — they are zero bytes once an agent completes. Do not read them for usage.

## Lint: two things you need to know

**1. Type-aware lint cannot run on this machine.** `.oxlintrc.json` sets `options.typeAware: true`,
which makes oxlint spawn `node_modules/@oxlint-tsgolint/win32-x64/tsgolint.exe`. That binary is
blocked by **Windows Smart App Control / Application Control** ("An Application Control policy has
blocked this file") because it is unsigned. It is not a mark-of-the-web issue — there is no
`Zone.Identifier` stream. This is a machine security policy and was deliberately **not** worked
around. To run type-aware rules, either allow the binary in the Windows security settings or run lint
in CI on a machine without that policy. `npx tsc --noEmit` is clean and covers much of the same
ground meanwhile.

To lint without the type-aware rules, generate a temporary config with
`options.typeAware`/`typeCheck` set to `false` (and `typescript/no-deprecated` removed, since it is
type-aware) and pass it with `oxlint -c`. Keep it out of the repo.

**2. Lint has never passed on this project.** As of the baseline commit there are ~28 pre-existing
errors: 15 in `components/ui/**` (vendored shadcn — mostly `jsx-a11y/prefer-tag-over-role`), 10 in
`app/page.tsx` (react-compiler ref access during render, `no-img-element`, unescaped entities), and
one each in `lib/lead-engine.ts`, `hooks/use-mobile.ts`. **None were introduced by this work.** Until
that debt is cleared, the merge gate is applied to *changed files only*, and each task records that
it did so. `app/page.tsx` is rewritten in T004, which should clear most of the non-vendored half.

## Env vars in use

None yet. Planned for the bridge (T005): `O6_BRIDGE_PORT`, `O6_BRIDGE_TOKEN`,
`O6_TRANSCRIPT_POLL_MS`, `O6_MAX_EVENTS`. Model API keys stay browser-held and BYOK — never written to
the repo, hosting metadata, or a client bundle.

## Running it

```sh
npm ci
npm run dev     # vinext dev; the original build session used http://localhost:3001
```

Gate before any merge:

```sh
npm run build
npx tsc --noEmit
npm run lint
node --experimental-strip-types --test tests/*.test.mjs
```

Baseline at relocation: 20/20 tests passing. After T002: **74/74**.

**`/lab` is the renderer's development harness** — mount the office against synthetic
streams (a full lead run including the carried-back beat, and a 6-wide burst), with
play/pause/scrub/speed, a compact-plan toggle and click-to-select. It is not the product;
`app/page.tsx` mounts the office for real in T004.

**`requestAnimationFrame` does not fire in the automated browser pane.** Verified: even a
hand-scheduled `requestAnimationFrame` never runs there, while `document.visibilityState`
still reports `visible` — so the usual "is the tab hidden?" check is misleading. Live
playback therefore cannot be verified from automation. Verify by **scrubbing** instead,
which drives the same `applyTime` path that the frame loop uses. This is also why
rendering deliberately does not live inside the rAF callback.

## Decisions

- **Palette corrected.** The Codex build invented `#3854ef` / `#f7f8fb`. The authoritative O6 tokens
  are Porcelain `#F7F7F4`, Mist `#E8E8F0`, Titanium `#B6BBC5`, Graphite `#1F2228`, O6 Violet `#7446FF`
  — violet capped at ≤5% of any application. In the office, violet is reserved exclusively for "this
  is happening right now", which satisfies the cap by construction.
- **Provider:** Anthropic added *alongside* OpenAI (T008), not replacing it.
- **`lib/lead-engine.ts` is not to be rewritten.** It is the strongest code in the repo — careful CSV
  parsing, dedup that preserves the strongest exclusion, 12 conservative qualification rules. Only
  `use-office.ts` changes.

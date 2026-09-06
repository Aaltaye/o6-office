#!/usr/bin/env node
/**
 * capture-session — reconstruct a Claude Code hook stream from session transcripts.
 *
 * Why this exists: the top product risk is the Claude Code adapter, not the renderer.
 * Forty `Read` calls in three seconds is not forty folder trips across an office, and if
 * burst handling is an afterthought the demo either seizures or quietly lies. So we want
 * *real* session timing to develop the renderer against, long before the live bridge
 * exists (PLAN.md C4).
 *
 * What this is, stated precisely: a **reconstruction**, not a live capture. It reads
 * transcripts that Claude Code already wrote to disk and emits the hook payloads that
 * *would* have fired. Timings, tool names, orderings and parallel batches are real. The
 * output records `"derivation": "reconstructed"` so nothing downstream can mistake it
 * for a live hook capture.
 *
 * Privacy: output is REDACTED by default, because these fixtures get committed. Prompt
 * text, tool inputs and tool results are replaced with structural summaries; file paths
 * are reduced to a basename. Pass --raw to keep content, and think hard before you do.
 *
 * Usage:
 *   node scripts/capture-session.mjs --out fixtures/captured-coding-session.json
 *   node scripts/capture-session.mjs --session <path-to-session.jsonl> --raw
 *   node scripts/capture-session.mjs --help
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function parseArgs(argv) {
  const args = { out: 'fixtures/captured-coding-session.json', raw: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--raw') args.raw = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--session') args.session = argv[++i];
    else throw new Error(`Unknown argument: ${arg}. Try --help.`);
  }
  return args;
}

const HELP = `capture-session — reconstruct a Claude Code hook stream from session transcripts

  --session <path>  Session transcript .jsonl. Default: the most recently modified one.
  --out <path>      Where to write the fixture. Default: fixtures/captured-coding-session.json
  --raw             Keep prompt/tool content. Off by default; fixtures are committed.
  --help            This message.

Output is a reconstruction of the hook payloads that would have fired, not a live
capture. Real timings, tool names, orderings and parallel batches; content redacted.
`;

/** Every session transcript on this machine, newest first. */
function findSessions() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const found = [];
  for (const project of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (extname(entry) !== '.jsonl') continue;
      const path = join(dir, entry);
      found.push({ path, mtime: statSync(path).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // A partially-flushed final line is normal on a live session.
      }
    })
    .filter(Boolean);
}

/**
 * Load the subagents that this session spawned.
 *
 * Discovered during T001: subagent activity does NOT appear in the parent transcript
 * (there are no `isSidechain` lines). Each subagent gets its own pair of files, keyed by
 * the same `agent_id` the SubagentStart hook delivers:
 *
 *   subagents/agent-<id>.jsonl       its messages, tool uses and per-message usage
 *   subagents/agent-<id>.meta.json   { agentType, description, toolUseId, spawnDepth }
 *
 * `meta.toolUseId` points back at the `Task` tool call in the parent that spawned it,
 * which is how we place the specialist's arrival at the right moment on the timeline.
 */
function loadSubagents(sessionPath) {
  const dir = join(dirname(sessionPath), basename(sessionPath, '.jsonl'), 'subagents');
  if (!existsSync(dir)) return [];
  const agents = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
    const id = entry.slice('agent-'.length, -'.jsonl'.length);
    const metaPath = join(dir, `agent-${id}.meta.json`);
    agents.push({
      id,
      meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {},
      lines: readJsonl(join(dir, entry)),
    });
  }
  return agents;
}

/**
 * The bare program name from a shell command, with everything else discarded.
 *
 * Naively taking the first whitespace token leaks paths, because a command commonly
 * starts with a variable assignment (`SRC=/c/Users/... cp "$SRC" ...`) or an absolute
 * path to an executable. So: skip leading assignments, take the next token, reduce a
 * path to its basename, and refuse anything still carrying shell syntax.
 */
function commandName(command) {
  const tokens = command.trim().split(/\s+/);
  let token = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (!token) return '<redacted>';
  // `/usr/bin/env node` and `./scripts/x.mjs` both reduce to a harmless leaf name.
  if (token.includes('/') || token.includes('\\')) token = basename(token.replace(/\\/g, '/'));
  // Anything left holding shell metacharacters could still carry content.
  if (/[$'"`=><|&();]/.test(token) || token === '') return '<redacted>';
  return token;
}

/** Structural summary of a tool input — enough to label a desk, not enough to leak. */
function summariseInput(toolName, input, raw) {
  if (raw) return input;
  if (!input || typeof input !== 'object') return {};
  const summary = {};
  // A basename is useful ("editing office.css") and much less revealing than a path.
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string') summary.file = basename(input[key]);
  }
  if (typeof input.pattern === 'string') summary.pattern = '<redacted>';
  if (typeof input.command === 'string') summary.command = commandName(input.command);
  if (typeof input.description === 'string') summary.description = input.description;
  if (typeof input.subagent_type === 'string') summary.subagent_type = input.subagent_type;
  if (typeof input.url === 'string') summary.url = '<redacted>';
  return summary;
}

function summariseText(text, raw) {
  if (raw) return text;
  if (typeof text !== 'string') return undefined;
  // Length is genuinely useful signal (a big result takes longer to read) and reveals
  // nothing on its own.
  return `<redacted ${text.length} chars>`;
}

const ts = (line) => (line.timestamp ? Date.parse(line.timestamp) : null);

/**
 * Walk one transcript and emit reconstructed hook payloads.
 *
 * `agentId` is null for the main session and set for a subagent, mirroring how real
 * Pre/PostToolUse hooks carry `agent_id` only when inside a subagent.
 */
function reconstruct(lines, { agentId, agentType, sessionId, raw }) {
  const events = [];
  /** tool_use_id -> the PreToolUse we emitted, so a result can be paired to its call. */
  const pending = new Map();

  const push = (hook, at, extra) => {
    events.push({
      hook_event_name: hook,
      occurred_at: at,
      session_id: sessionId,
      ...(agentId ? { agent_id: agentId, agent_type: agentType } : {}),
      ...extra,
    });
  };

  for (const line of lines) {
    const at = ts(line);
    if (at === null) continue;
    const content = line.message?.content;

    if (line.type === 'user') {
      // A user line is either a real prompt or the tool results coming back.
      if (typeof content === 'string') {
        push('UserPromptSubmit', at, { prompt: summariseText(content, raw) });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const call = pending.get(block.tool_use_id);
          if (!call) continue;
          pending.delete(block.tool_use_id);
          const text = Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? '').join('')
            : block.content;
          push(block.is_error ? 'PostToolUseFailure' : 'PostToolUse', at, {
            tool_name: call.tool_name,
            tool_use_id: block.tool_use_id,
            ...(block.is_error
              ? { tool_error: summariseText(text, raw) }
              : { tool_response: summariseText(text, raw) }),
          });
        }
      }
      continue;
    }

    if (line.type !== 'assistant' || !Array.isArray(content)) continue;

    // Every tool_use in ONE assistant message was issued in parallel, so they share a
    // timestamp. Preserving that is the whole point of this fixture — it is the burst
    // case the renderer must not serialise into a fake sequence (invariant I5).
    const calls = content.filter((block) => block.type === 'tool_use');
    for (const call of calls) {
      pending.set(call.id, { tool_name: call.name });
      push('PreToolUse', at, {
        tool_name: call.name,
        tool_use_id: call.id,
        tool_input: summariseInput(call.name, call.input, raw),
      });
    }
    if (calls.length > 1) {
      push('PostToolBatch', at, {
        tool_calls: calls.map((c) => ({ tool_name: c.name, tool_use_id: c.id })),
      });
    }

    // Usage is not delivered by any hook; it is read from the transcript. Carrying it as
    // a distinct record keeps that provenance explicit rather than pretending a hook
    // supplied it.
    const usage = line.message?.usage;
    if (usage) {
      events.push({
        hook_event_name: null,
        record: 'usage',
        source: 'transcript',
        occurred_at: at,
        session_id: sessionId,
        ...(agentId ? { agent_id: agentId } : {}),
        model: line.message.model,
        input_tokens: usage.input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        thinking_tokens: usage.output_tokens_details?.thinking_tokens ?? 0,
      });
    }
  }

  return events;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const sessionPath = args.session ?? findSessions()[0];
  if (!sessionPath || !existsSync(sessionPath)) {
    // Honest failure: say what was looked for and where, do not emit an empty fixture.
    throw new Error(
      `No session transcript found. Looked under ${PROJECTS_DIR}. Pass --session <path>.`,
    );
  }

  const lines = readJsonl(sessionPath);
  if (lines.length === 0) throw new Error(`Session transcript is empty: ${sessionPath}`);

  const sessionId = lines.find((l) => l.sessionId)?.sessionId ?? basename(sessionPath, '.jsonl');
  const subagents = loadSubagents(sessionPath);

  const events = reconstruct(lines, { agentId: null, agentType: null, sessionId, raw: args.raw });

  // Splice each specialist in at the moment the parent called Task, so arrival and
  // departure land at the right points on the timeline.
  for (const agent of subagents) {
    const spawnedBy = events.find(
      (e) => e.hook_event_name === 'PreToolUse' && e.tool_use_id === agent.meta.toolUseId,
    );
    const agentLines = agent.lines;
    const startAt = spawnedBy?.occurred_at ?? (agentLines.length ? ts(agentLines[0]) : null);
    const endAt = agentLines.length ? ts(agentLines[agentLines.length - 1]) : startAt;
    if (startAt === null) continue;

    events.push({
      hook_event_name: 'SubagentStart',
      occurred_at: startAt,
      session_id: sessionId,
      agent_id: agent.id,
      agent_type: agent.meta.agentType,
      // The specialist's literal assignment. Using this as the desk label means the
      // office never has to invent one.
      description: agent.meta.description,
      spawn_depth: agent.meta.spawnDepth,
    });

    events.push(
      ...reconstruct(agentLines, {
        agentId: agent.id,
        agentType: agent.meta.agentType,
        sessionId,
        raw: args.raw,
      }),
    );

    events.push({
      hook_event_name: 'SubagentStop',
      occurred_at: endAt,
      session_id: sessionId,
      agent_id: agent.id,
      agent_type: agent.meta.agentType,
    });
  }

  // Sort by when things happened; ties keep insertion order because Array#sort is stable,
  // which is what preserves a parallel batch as a parallel batch.
  events.sort((a, b) => a.occurred_at - b.occurred_at);

  const first = events[0]?.occurred_at ?? 0;
  const fixture = {
    v: 1,
    derivation: 'reconstructed from session transcripts on disk; NOT a live hook capture',
    redacted: !args.raw,
    capturedAt: new Date().toISOString(),
    sessionId,
    durationMs: (events[events.length - 1]?.occurred_at ?? 0) - first,
    subagents: subagents.map((a) => ({
      agent_id: a.id,
      agent_type: a.meta.agentType,
      description: a.meta.description,
      spawn_depth: a.meta.spawnDepth,
    })),
    // Relative timestamps so a replay does not depend on the wall clock it was recorded at.
    events: events.map((e) => ({ ...e, occurred_at: e.occurred_at - first })),
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(fixture, null, 2)}\n`);

  const byHook = {};
  for (const e of fixture.events) {
    const key = e.hook_event_name ?? `record:${e.record}`;
    byHook[key] = (byHook[key] ?? 0) + 1;
  }
  // Simultaneity is the property this fixture exists to preserve — report it loudly so a
  // capture that lost it is obvious.
  const groups = new Map();
  for (const e of fixture.events) groups.set(e.occurred_at, (groups.get(e.occurred_at) ?? 0) + 1);
  const biggestBurst = Math.max(...groups.values());

  process.stdout.write(
    `Wrote ${args.out}\n` +
      `  session:      ${sessionId}\n` +
      `  duration:     ${(fixture.durationMs / 1000).toFixed(1)}s\n` +
      `  events:       ${fixture.events.length}\n` +
      `  subagents:    ${subagents.length}\n` +
      `  redacted:     ${fixture.redacted}\n` +
      `  largest simultaneous group: ${biggestBurst}\n` +
      `  by hook:      ${JSON.stringify(byHook)}\n`,
  );
}

main();

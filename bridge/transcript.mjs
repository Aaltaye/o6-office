/**
 * bridge/transcript — where the token numbers actually come from.
 *
 * No Claude Code hook payload carries usage. Every hook does carry `transcript_path`, and
 * the transcript records real per-message usage, so that is the only honest source — and
 * every event this module emits says `source: 'transcript'` so the office can show where
 * the number came from.
 *
 * The layout, established by inspecting a real session rather than assumed:
 *
 *   <project>/<sessionId>.jsonl                       the main session
 *   <project>/<sessionId>/subagents/agent-<id>.jsonl  each subagent's own messages
 *   <project>/<sessionId>/subagents/agent-<id>.meta.json  { agentType, description, … }
 *
 * Subagent activity does NOT appear in the main transcript. The obvious guess — that
 * subagent messages are inlined and flagged `isSidechain` — is wrong; there are no such
 * lines. That is why this watches a *directory*: new `agent-*.jsonl` files appear as
 * subagents spawn, and `agent_id` in the filename is exactly what `SubagentStart`
 * delivers, so per-subagent attribution is a direct join.
 *
 * Model pricing is deliberately absent. We report tokens, which we know, and leave cost
 * to whoever knows the rate — a confidently wrong dollar figure is worse than none.
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** Everything we can honestly say about one assistant message's usage. */
function readUsage(line) {
  const usage = line?.message?.usage;
  if (!usage) return null;
  return {
    /*
     * One assistant message is written to the transcript as SEVERAL lines. Each line gets
     * its own `uuid`, but they share `message.id` and every one of them repeats the same
     * cumulative usage object. Counting per line therefore reports roughly twice the
     * tokens actually spent — measured on a real 3,615-line transcript: 1,210 usage lines
     * for 635 messages. The id is what lets us count a message once.
     */
    messageId: line.message?.id ?? line.uuid ?? null,
    model: line.message.model,
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    // Cache creation is billed differently from plain input, so it is kept distinct
    // rather than folded in and misreported.
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** Where a session's subagent transcripts live, derived from the main transcript path. */
export function subagentsDirFor(transcriptPath) {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
}

/**
 * Follows a session's transcripts and reports usage as it appears.
 *
 * Polls rather than watches: transcripts are appended to by another process, and
 * `fs.watch` is unreliable across platforms for that. Polling a file size is cheap, and
 * the poll interval is configurable.
 */
export class TranscriptWatcher {
  /**
   * @param {string} transcriptPath main session .jsonl
   * @param {(usage: object) => void} onUsage called per new assistant message with usage
   * @param {{pollMs?: number, onWarn?: (message: string) => void}} options
   */
  constructor(transcriptPath, onUsage, options = {}) {
    this.transcriptPath = transcriptPath;
    this.onUsage = onUsage;
    this.pollMs = options.pollMs ?? 1000;
    this.onWarn = options.onWarn ?? (() => {});
    /** Byte offset already consumed, per file. */
    this.offsets = new Map();
    /** agent_id -> meta.json contents, so a subagent's usage can be named. */
    this.agentMeta = new Map();
    /** `file::messageId` already reported, so one message is never counted twice. */
    this.seenMessages = new Set();
    /** Files whose pre-existing backlog has already been folded into a catch-up total. */
    this.primed = new Set();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    // Read once immediately so a bridge started mid-session is not blank for a second.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    // Never hold the process open just to poll.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read whatever is new in one file, returning parsed lines. */
  readNew(path) {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return []; // not written yet; it will appear on a later tick
    }
    const from = this.offsets.get(path) ?? 0;
    if (size <= from) {
      // A transcript that shrank was replaced (a new session reusing the path). Start over.
      if (size < from) this.offsets.set(path, 0);
      return [];
    }

    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      this.onWarn(`could not read ${basename(path)}: ${error.message}`);
      return [];
    }

    // Only consume up to the last complete line: the file is being appended to, so the
    // tail may be a half-written record.
    const slice = text.slice(from);
    const lastNewline = slice.lastIndexOf('\n');
    if (lastNewline < 0) return [];
    this.offsets.set(path, from + lastNewline + 1);

    return slice
      .slice(0, lastNewline)
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** New usage from one file, with each assistant message counted exactly once. */
  freshUsage(path) {
    const out = [];
    for (const line of this.readNew(path)) {
      const usage = readUsage(line);
      if (!usage) continue;
      if (usage.messageId) {
        const key = `${path}::${usage.messageId}`;
        if (this.seenMessages.has(key)) continue;
        this.seenMessages.add(key);
      }
      out.push(usage);
    }
    return out;
  }

  /**
   * Report a file's new usage.
   *
   * The first read of a transcript is different in kind from every later one: it is the
   * session *so far*, which happened before the office was watching. Replaying it message
   * by message would stamp hundreds of events with the current time and show a burst of
   * work that did not just occur — the same lie as animating movement nothing justifies.
   * So the backlog is folded into one total that says exactly what it is, and everything
   * after it is reported as it arrives.
   */
  report(path, tag) {
    const fresh = this.freshUsage(path);
    if (!fresh.length) return;
    const first = !this.primed.has(path);
    this.primed.add(path);

    if (!first || fresh.length === 1) {
      for (const usage of fresh) this.onUsage({ ...usage, ...tag, catchUp: false, messages: 1 });
      return;
    }

    const total = (field) => fresh.reduce((n, usage) => n + (usage[field] ?? 0), 0);
    const models = new Set(fresh.map((usage) => usage.model).filter(Boolean));
    this.onUsage({
      ...tag,
      catchUp: true,
      messages: fresh.length,
      // A backlog can span more than one model, and naming just one of them would be a
      // quiet fiction.
      model: models.size === 1 ? [...models][0] : 'mixed',
      inputTokens: total('inputTokens'),
      cachedInputTokens: total('cachedInputTokens'),
      outputTokens: total('outputTokens'),
      cacheCreationTokens: total('cacheCreationTokens'),
      thinkingTokens: total('thinkingTokens'),
    });
  }

  tick() {
    // Main session.
    this.report(this.transcriptPath, { worker: null, role: null });

    // Subagents. A directory, not a file: new ones appear as they spawn.
    const dir = subagentsDirFor(this.transcriptPath);
    if (!existsSync(dir)) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch (error) {
      this.onWarn(`could not list subagents: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
      const agentId = entry.slice('agent-'.length, -'.jsonl'.length);

      if (!this.agentMeta.has(agentId)) {
        const metaPath = join(dir, `agent-${agentId}.meta.json`);
        try {
          this.agentMeta.set(
            agentId,
            existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {},
          );
        } catch {
          this.agentMeta.set(agentId, {});
        }
      }
      const meta = this.agentMeta.get(agentId) ?? {};

      this.report(join(dir, entry), {
        // Matches the worker id the hook mapping assigns, so the office can put a
        // subagent's token burn on that subagent's desk.
        worker: `agent:${agentId}`,
        role: meta.agentType ?? null,
        assignment: meta.description ?? null,
      });
    }
  }
}

/**
 * Read a whole session's usage once, without following it.
 *
 * Used by the smoke test and by anything that wants a total rather than a stream.
 */
export function readSessionUsage(transcriptPath) {
  const totals = { main: null, agents: new Map() };
  const watcher = new TranscriptWatcher(transcriptPath, (usage) => {
    const key = usage.worker ?? 'main';
    const bucket =
      key === 'main'
        ? (totals.main ??= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, messages: 0 })
        : (totals.agents.get(key) ??
          totals.agents
            .set(key, {
              worker: key,
              role: usage.role,
              assignment: usage.assignment,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              messages: 0,
            })
            .get(key));
    bucket.inputTokens += usage.inputTokens;
    bucket.cachedInputTokens += usage.cachedInputTokens;
    bucket.outputTokens += usage.outputTokens;
    // A catch-up entry stands for many messages, not one.
    bucket.messages += usage.messages ?? 1;
  });
  watcher.tick();
  return { main: totals.main, agents: [...totals.agents.values()] };
}

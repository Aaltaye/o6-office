/**
 * T005 — the local bridge.
 *
 * The bridge takes untrusted input (anything on the machine can POST to a local port)
 * and its output drives a visualisation people are asked to believe. So the tests here
 * are mostly about refusing things: bad tokens, malformed payloads, oversized bodies,
 * and path traversal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBridge } from '../bridge/server.mjs';
import { loadConfig, requireToken, suggestToken } from '../bridge/config.mjs';
import { TranscriptWatcher, readSessionUsage, subagentsDirFor } from '../bridge/transcript.mjs';
import { connectProject, mergeHooks } from '../bridge/connect.mjs';
import { loadOfficeConfig } from '../bridge/office-config.mjs';
import { buildEvent, sendEvent } from '../bridge/emit.mjs';
import { DESKS } from '../bridge/emit.mjs';
import { describeProblems } from '../bridge/contract.mjs';
import { codingSessionPlan } from '../lib/floorplans/coding-session.ts';
import { surveyProject, planSteps, verifyRoundTrip } from '../bridge/wizard.mjs';
import { isOfficeEvent } from '../lib/office-view/core/events.ts';

const TOKEN = 'test-token-that-is-long-enough';

/** Start a bridge on an ephemeral port and hand back helpers for talking to it. */
async function withBridge(run, options = {}) {
  const bridge = createBridge({ token: TOKEN, port: 0, log: () => {}, ...options });
  await bridge.listen();
  const { port } = bridge.server.address();
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    await run({ bridge, url, port });
  } finally {
    await bridge.close();
  }
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the bridge refuses to start without a token', () => {
  // Defaulting to open would be the wrong failure mode: it receives your session.
  assert.throws(() => requireToken(loadConfig({})), /will not start without one/);
  assert.throws(() => requireToken(loadConfig({ O6_BRIDGE_TOKEN: 'changeme' })), /placeholder/);
  assert.throws(() => requireToken(loadConfig({ O6_BRIDGE_TOKEN: 'short' })), /too short/);
  assert.equal(requireToken(loadConfig({ O6_BRIDGE_TOKEN: TOKEN })), TOKEN);
});

test('a suggested token is long and URL-safe', () => {
  const token = suggestToken();
  assert.ok(token.length >= 24);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('config is all knobs, no magic numbers', () => {
  const config = loadConfig({
    O6_BRIDGE_PORT: '5000', O6_MAX_EVENTS: '10', O6_TRANSCRIPT_POLL_MS: '250',
  });
  assert.equal(config.host, '127.0.0.1', 'loopback only, always');
  assert.equal(config.port, 5000);
  assert.equal(config.maxEvents, 10);
  assert.equal(config.pollMs, 250);
  // Nonsense falls back rather than producing a zero interval or a negative cap.
  assert.equal(loadConfig({ O6_BRIDGE_PORT: 'banana' }).port, 4141);
  assert.equal(loadConfig({ O6_MAX_EVENTS: '-5' }).maxEvents, 5000);
});

// ---------------------------------------------------------------------------
// Auth and input handling
// ---------------------------------------------------------------------------

test('hooks without a valid token are rejected', async () => {
  await withBridge(async ({ url }) => {
    const payload = { hook_event_name: 'SessionStart', session_id: 's1' };
    assert.equal((await post(url('/hook'), payload)).status, 401, 'no token');
    assert.equal(
      (await post(url('/hook'), payload, { 'x-o6-token': 'wrong-token-same-length-ish' })).status,
      401,
      'wrong token',
    );
    assert.equal((await fetch(url('/events'))).status, 401, 'the stream is protected too');
  });
});

test('a valid hook is accepted and becomes a contract-valid event', async () => {
  await withBridge(async ({ bridge, url }) => {
    const response = await post(
      url('/hook'),
      { hook_event_name: 'SessionStart', session_id: 's1' },
      { 'x-o6-token': TOKEN },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, events: 1 });

    assert.equal(bridge.events.length, 1);
    const event = bridge.events[0];
    assert.equal(isOfficeEvent(event), true);
    assert.equal(event.source, 'claude-code');
    assert.equal(event.type, 'run.started');
    assert.ok(event.receivedAt >= event.occurredAt, 'arrival is recorded separately');
  });
});

test('malformed payloads are refused, not crashed on', async () => {
  await withBridge(async ({ bridge, url }) => {
    const bad = await post(url('/hook'), 'not json at all', { 'x-o6-token': TOKEN });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /unreadable payload/);

    // Valid JSON that is not a hook is accepted at the transport level but produces
    // nothing, rather than being guessed at.
    const empty = await post(url('/hook'), { not: 'a hook' }, { 'x-o6-token': TOKEN });
    assert.deepEqual(await empty.json(), { ok: true, events: 0 });
    assert.equal(bridge.events.length, 0);
  });
});

test('an oversized body is rejected', async () => {
  await withBridge(async ({ url }) => {
    const huge = JSON.stringify({ hook_event_name: 'Stop', big: 'x'.repeat(600_000) });
    const response = await post(url('/hook'), huge, { 'x-o6-token': TOKEN }).catch((e) => e);
    // Either a 4xx or a dropped connection is acceptable; silently accepting is not.
    if (response instanceof Error) assert.ok(response);
    else assert.ok(response.status >= 400, `expected rejection, got ${response.status}`);
  });
});

test('a future Claude Code hook is ignored without crashing the bridge', async () => {
  await withBridge(async ({ bridge, url }) => {
    const response = await post(
      url('/hook'),
      { hook_event_name: 'SomeHookFromNextYear', session_id: 's1' },
      { 'x-o6-token': TOKEN },
    );
    assert.deepEqual(await response.json(), { ok: true, events: 0 });
    // And the bridge still works afterwards.
    await post(url('/hook'), { hook_event_name: 'SessionStart' }, { 'x-o6-token': TOKEN });
    assert.equal(bridge.events.length, 1);
  });
});

test('static serving cannot escape its directory', async () => {
  await withBridge(async ({ url }) => {
    const response = await fetch(url('/../../../package.json'));
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
    const body = await response.text();
    assert.ok(!body.includes('"dependencies"'), 'must not serve files outside bridge/public');
  });
});

// ---------------------------------------------------------------------------
// Streaming and bounds
// ---------------------------------------------------------------------------

test('the event stream replays what happened and then follows', async () => {
  await withBridge(async ({ url }) => {
    await post(url('/hook'), { hook_event_name: 'SessionStart' }, { 'x-o6-token': TOKEN });

    const response = await fetch(url(`/events?token=${encodeURIComponent(TOKEN)}`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const reader = response.body.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());

    // The backlog arrives first, so a browser opened mid-session is not blank.
    assert.match(await read(), /"type":"run\.started"/);

    await post(
      url('/hook'),
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, prompt_id: 'p1' },
      { 'x-o6-token': TOKEN },
    );
    assert.match(await read(), /"type":"assignment\.started"/);
    await reader.cancel();
  });
});

test('the ring buffer is bounded so a long session cannot grow without limit', async () => {
  await withBridge(
    async ({ bridge, url }) => {
      for (let i = 0; i < 12; i++) {
        await post(url('/hook'), { hook_event_name: 'Stop', prompt_id: 'p1' }, { 'x-o6-token': TOKEN });
      }
      assert.equal(bridge.events.length, 5, 'oldest events are dropped, newest kept');
      // Sequence numbers keep climbing, so ordering survives the drop.
      assert.equal(bridge.events.at(-1).seq, 12);
    },
    { maxEvents: 5 },
  );
});

test('health reports what the bridge is doing', async () => {
  await withBridge(async ({ url }) => {
    const health = await (await fetch(url('/health'))).json();
    assert.equal(health.ok, true);
    assert.equal(health.events, 0);
  });
});

// ---------------------------------------------------------------------------
// Usage from the transcript
// ---------------------------------------------------------------------------

/** Build a session transcript plus one subagent, in the real on-disk layout. */
function makeSession() {
  const dir = mkdtempSync(join(tmpdir(), 'o6-transcript-'));
  const transcript = join(dir, 'session.jsonl');
  const line = (usage, model = 'claude-opus-5') =>
    `${JSON.stringify({ type: 'assistant', message: { model, usage } })}\n`;

  writeFileSync(
    transcript,
    line({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 }),
  );

  const subagents = subagentsDirFor(transcript);
  mkdirSync(subagents, { recursive: true });
  writeFileSync(
    join(subagents, 'agent-abc.meta.json'),
    JSON.stringify({ agentType: 'Plan', description: 'Design the renderer' }),
  );
  writeFileSync(
    join(subagents, 'agent-abc.jsonl'),
    line({ input_tokens: 3, cache_read_input_tokens: 900, output_tokens: 7 }),
  );

  return { dir, transcript };
}

test('usage is read from the transcript and attributed per subagent', () => {
  // The join that makes the intern's token burn appear on the intern's desk: the
  // filename's agent id is exactly what SubagentStart delivers.
  const { dir, transcript } = makeSession();
  try {
    const usage = readSessionUsage(transcript);
    assert.equal(usage.main.inputTokens, 10);
    assert.equal(usage.main.outputTokens, 20);

    assert.equal(usage.agents.length, 1);
    assert.equal(usage.agents[0].worker, 'agent:abc');
    assert.equal(usage.agents[0].role, 'Plan');
    assert.equal(usage.agents[0].assignment, 'Design the renderer');
    assert.equal(usage.agents[0].cachedInputTokens, 900);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the watcher only reports each message once, and picks up appended lines', () => {
  const { dir, transcript } = makeSession();
  try {
    const seen = [];
    const watcher = new TranscriptWatcher(transcript, (u) => seen.push(u), { pollMs: 10 });
    watcher.tick();
    const afterFirst = seen.length;
    assert.ok(afterFirst >= 2, 'main session plus subagent');

    watcher.tick();
    assert.equal(seen.length, afterFirst, 'a second pass must not re-report the same messages');

    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 2 } } })}\n`,
      { flag: 'a' },
    );
    watcher.tick();
    assert.equal(seen.length, afterFirst + 1, 'appended lines are picked up');
    watcher.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a half-written trailing line is not parsed until it is complete', () => {
  // Transcripts are appended to by another process, so the tail is often partial.
  const dir = mkdtempSync(join(tmpdir(), 'o6-partial-'));
  const transcript = join(dir, 'session.jsonl');
  try {
    writeFileSync(transcript, '{"type":"assistant","message":{"usage":{"input_tok');
    const seen = [];
    const watcher = new TranscriptWatcher(transcript, (u) => seen.push(u));
    watcher.tick();
    assert.equal(seen.length, 0, 'nothing reported from an incomplete line');

    writeFileSync(transcript, 'ens":4,"output_tokens":1}}}\n', { flag: 'a' });
    watcher.tick();
    assert.equal(seen.length, 1, 'reported once the line is complete');
    assert.equal(seen[0].inputTokens, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing transcript reports usage as unavailable, never as zero', async () => {
  // A confident 0 would read as "this session was free", which is false.
  await withBridge(async ({ bridge, url }) => {
    await post(
      url('/hook'),
      { hook_event_name: 'SessionStart', transcript_path: join(tmpdir(), 'does-not-exist.jsonl') },
      { 'x-o6-token': TOKEN },
    );
    const unavailable = bridge.events.find((e) => e.type === 'usage.reported');
    assert.ok(unavailable, 'the office must be told usage cannot be read');
    assert.equal(unavailable.usage.source, 'unavailable');
    assert.equal(unavailable.usage.inputTokens, undefined, 'no invented number');
  });
});

/* --- usage accounting ------------------------------------------------------
 *
 * These pin two defects found by pointing the watcher at a real 12 MB Claude Code
 * transcript. Both produced plausible-looking output, which is exactly why they need
 * tests rather than a glance: one inflated every token figure by roughly half, and the
 * other claimed hundreds of messages had just happened the moment the office connected.
 */

/** One assistant message, as Claude Code writes it: several lines sharing a message id. */
function messageLines(messageId, usage, lineCount = 2) {
  return Array.from({ length: lineCount }, (unused, index) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `${messageId}-line-${index}`,
      message: { id: messageId, model: 'claude-opus-5', usage },
    }),
  );
}

const USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 5,
  output_tokens: 20,
  output_tokens_details: { thinking_tokens: 3 },
};

/** A temp dir holding a transcript, plus the subagent layout the watcher expects. */
function withTranscript(run) {
  const dir = mkdtempSync(join(tmpdir(), 'o6-transcript-'));
  const transcript = join(dir, 'session.jsonl');
  try {
    run({ dir, transcript, subagents: subagentsDirFor(transcript) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('one assistant message spread over several lines is counted once', () => {
  // Measured on a real transcript: 1,210 lines carried usage but only 654 were distinct
  // messages. Counting per line reported roughly 1.8x the tokens actually spent.
  withTranscript(({ transcript }) => {
    writeFileSync(
      transcript,
      [...messageLines('msg_a', USAGE, 3), ...messageLines('msg_b', USAGE, 2)].join('\n') + '\n',
    );
    const seen = [];
    new TranscriptWatcher(transcript, (usage) => seen.push(usage)).tick();

    assert.equal(seen.length, 1, 'the backlog is one catch-up entry');
    assert.equal(seen[0].messages, 2, 'two messages, not the five lines that carried them');
    assert.equal(seen[0].outputTokens, 40, 'each message counted once');
  });
});

test('work that predates the connection is reported as a total, not as a burst', () => {
  // Replaying history message-by-message would stamp every one with the current time and
  // show a flood of work that did not just happen — the same lie as an unjustified walk.
  withTranscript(({ transcript }) => {
    const lines = [];
    for (let i = 0; i < 40; i += 1) lines.push(...messageLines(`msg_${i}`, USAGE, 2));
    writeFileSync(transcript, lines.join('\n') + '\n');

    const seen = [];
    new TranscriptWatcher(transcript, (usage) => seen.push(usage)).tick();

    assert.equal(seen.length, 1, '40 messages arrive as one total, not 40 events');
    assert.equal(seen[0].catchUp, true, 'and it is flagged as a catch-up, so it can say so');
    assert.equal(seen[0].messages, 40);
    assert.equal(seen[0].outputTokens, 800);
  });
});

test('usage that arrives after connecting is reported as it happens', () => {
  withTranscript(({ transcript }) => {
    writeFileSync(transcript, messageLines('msg_old', USAGE, 2).join('\n') + '\n');
    const seen = [];
    const watcher = new TranscriptWatcher(transcript, (usage) => seen.push(usage));
    watcher.tick();
    assert.equal(seen.length, 1, 'the backlog');

    watcher.tick();
    assert.equal(seen.length, 1, 'a tick with nothing new reports nothing');

    appendFileSync(transcript, messageLines('msg_new', USAGE, 2).join('\n') + '\n');
    watcher.tick();
    assert.equal(seen.length, 2, 'new work is reported');
    assert.equal(seen[1].catchUp, false, 'and it is live, not a catch-up');
    assert.equal(seen[1].messages, 1);
  });
});

test('a subagent’s tokens are attributed to that subagent, not to the session', () => {
  // This is the beat the whole product is built around: a specialist called in for one
  // job, and you can see what that job cost. It has to be real, not apportioned.
  withTranscript(({ transcript, subagents }) => {
    writeFileSync(transcript, messageLines('msg_main', USAGE, 2).join('\n') + '\n');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-abc123.jsonl'),
      messageLines('msg_sub', USAGE, 2).join('\n') + '\n',
    );
    writeFileSync(
      join(subagents, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'Plan', description: 'Design the renderer' }),
    );

    const seen = [];
    new TranscriptWatcher(transcript, (usage) => seen.push(usage)).tick();

    const sub = seen.find((usage) => usage.worker === 'agent:abc123');
    assert.ok(sub, 'the subagent is reported under the same id the hook mapping uses');
    assert.equal(sub.role, 'Plan', 'named from its meta, not guessed');
    assert.equal(sub.assignment, 'Design the renderer');
    assert.equal(sub.outputTokens, 20, 'its own tokens only');

    const main = seen.find((usage) => usage.worker === null);
    assert.equal(main.outputTokens, 20, 'the session keeps its own, unmixed');
  });
});

test('session totals count messages, not the lines they were written across', () => {
  withTranscript(({ transcript }) => {
    writeFileSync(
      transcript,
      [...messageLines('msg_a', USAGE, 3), ...messageLines('msg_b', USAGE, 3)].join('\n') + '\n',
    );
    const totals = readSessionUsage(transcript);
    assert.equal(totals.main.messages, 2, 'two messages across six lines');
    assert.equal(totals.main.outputTokens, 40);
  });
});

test('a tool call with no tool_use_id still reaches the office', async () => {
  // The mapping sets `id` from tool_use_id, so a hook without one left the key present and
  // undefined. Spreading it last clobbered the envelope's generated id, the event failed
  // validation, and the client dropped it silently — work that happened, never shown.
  await withBridge(async ({ bridge, url }) => {
    await fetch(url('/hook'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': TOKEN },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/a/b.ts' },
      }),
    });

    const event = bridge.events.at(-1);
    assert.ok(event, 'the hook produced no event at all');
    assert.equal(typeof event.id, 'string');
    assert.ok(event.id.length > 0, 'the envelope id was clobbered by an absent tool_use_id');
    assert.ok(isOfficeEvent(event), 'the event does not satisfy the contract');
    assert.ok(
      isOfficeEvent(JSON.parse(JSON.stringify(event))),
      'it must also survive the JSON round trip the SSE wire performs',
    );
  });
});

test('the bridge counts its own malformed events rather than hiding them', async () => {
  await withBridge(async ({ url }) => {
    const health = await (await fetch(url('/health'), { headers: { 'x-o6-token': TOKEN } })).json();
    assert.equal(health.malformed, 0, 'a clean run reports zero, and reports it explicitly');
  });
});

test('any agent can post the contract directly, not just Claude Code', async () => {
  // /hook translates one product's hook shape. The contract is the actual seam, so an
  // agent runtime with no hook system needs a way to speak it, or "connect your work" is
  // a claim about Claude Code rather than about agents.
  await withBridge(async ({ bridge, url }) => {
    const res = await fetch(url('/event'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': TOKEN },
      body: JSON.stringify([
        { type: 'run.started', label: 'My agent starts work' },
        { type: 'assignment.started', label: 'Reading the spec', station: 'reading' },
      ]),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.events, 2);
    assert.deepEqual(body.rejected, []);

    for (const event of bridge.events) {
      assert.ok(isOfficeEvent(event), `the bridge produced an event the office cannot read`);
    }
    assert.equal(bridge.events[1].station, 'reading');
  });
});

test('a direct event that says nothing is refused, with the reason', async () => {
  await withBridge(async ({ bridge, url }) => {
    const res = await fetch(url('/event'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': TOKEN },
      body: JSON.stringify({ type: 'assignment.started', station: 'reading' }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.events, 0);
    assert.match(body.rejected[0].why, /label/, 'it must say why, not just fail');
    assert.equal(bridge.events.length, 0, 'and nothing unlabelled reaches the floor');
  });
});

test('the direct endpoint refuses an unauthenticated caller like every other one', async () => {
  await withBridge(async ({ url }) => {
    const res = await fetch(url('/event'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'run.started', label: 'no token' }),
    });
    assert.equal(res.status, 401);
  });
});

test('the office UI is never served from a stale cache', async () => {
  // index.html exists to name the current hashed bundle. A cached copy pins the browser to
  // a client build that no longer exists on disk: you rebuild, reload, and quietly get the
  // old UI with nothing to explain it. Cost an hour once; now it is pinned.
  await withBridge(async ({ url }) => {
    const res = await fetch(url('/'));
    // The UI may not be built in a clean checkout, and that is fine — the header is what
    // matters, and the 404 body says how to build it.
    if (res.status === 200) {
      assert.match(
        res.headers.get('cache-control') ?? '',
        /no-store/,
        'the shell must not be cached',
      );
    } else {
      assert.equal(res.status, 404);
    }
  });
});

/* --- connecting a project, and reporting from anything else -----------------
 *
 * These two commands exist because the step people gave up at was hand-merging ~90 lines
 * of JSON, and because every runtime that is not Claude Code had no path in at all.
 * `connect` edits somebody's editor configuration, so its tests are mostly about what it
 * must NOT do.
 */

/** A throwaway project directory, optionally with existing Claude settings. */
function withProject(existing, run) {
  const root = mkdtempSync(join(tmpdir(), 'o6-project-'));
  if (existing) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(existing, null, 2));
  }
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HOOKS = {
  PreToolUse: [{ hooks: [{ type: 'command', command: 'curl -s http://127.0.0.1:4141/hook' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'curl -s http://127.0.0.1:4141/hook' }] }],
};

test('connecting never drops settings or hooks that were already there', () => {
  // The worst bug this command could have is quietly damaging an editor config. Someone
  // else's hook is not ours to reorganise.
  withProject(
    {
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] },
    },
    (root) => {
      const report = connectProject({ projectRoot: root, hooks: HOOKS });
      const written = JSON.parse(readFileSync(report.path, 'utf8'));

      assert.deepEqual(written.permissions, { allow: ['Bash(ls)'] }, 'unrelated settings kept');
      assert.equal(written.hooks.PreToolUse.length, 2, 'theirs plus ours');
      assert.ok(JSON.stringify(written.hooks.PreToolUse).includes('echo theirs'), 'theirs survived');
      assert.ok(report.backup && existsSync(report.backup), 'the original was backed up');
    },
  );
});

test('connecting twice does not stack up duplicate hooks', () => {
  withProject({}, (root) => {
    connectProject({ projectRoot: root, hooks: HOOKS });
    const second = connectProject({ projectRoot: root, hooks: HOOKS });
    const written = JSON.parse(readFileSync(second.path, 'utf8'));

    assert.equal(written.hooks.PreToolUse.length, 1, 'ours replaced, not appended');
    assert.deepEqual(second.replaced.sort(), ['PreToolUse', 'Stop'], 'and it says it refreshed them');
  });
});

test('connecting works in a project that has no settings file yet', () => {
  withProject(null, (root) => {
    const report = connectProject({ projectRoot: root, hooks: HOOKS });
    assert.equal(report.existed, false);
    assert.equal(report.backup, null, 'nothing to back up');
    assert.ok(existsSync(report.path), 'the file and its directory were created');
  });
});

test('a dry run changes nothing on disk', () => {
  withProject({ permissions: {} }, (root) => {
    const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
    const report = connectProject({ projectRoot: root, hooks: HOOKS, dryRun: true });
    assert.equal(readFileSync(report.path, 'utf8'), before, 'file untouched');
    assert.ok(report.added.length > 0, 'but it still reports what it would do');
  });
});

test('connecting refuses to overwrite settings it cannot parse', () => {
  const root = mkdtempSync(join(tmpdir(), 'o6-project-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), '{ this is not json');
  try {
    assert.throws(
      () => connectProject({ projectRoot: root, hooks: HOOKS }),
      /not valid JSON/,
      'better to refuse than to destroy a file we cannot read',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emit refuses exactly what the office would have dropped', () => {
  // Before this, five of the documented event shapes passed the door with {ok:true} and
  // were then discarded by the renderer for a missing required field — a success response
  // and an empty floor. emit and the door now share one contract, so neither can accept
  // something the other would throw away.
  assert.throws(() => buildEvent({ type: 'note' }), /missing "label"/);
  assert.throws(() => buildEvent({ type: 'made.up', label: 'x' }), /Unknown event type/);
  assert.throws(
    () => buildEvent({ type: 'assignment.started', label: 'Reading' }),
    /needs "station"/,
    'work has to happen somewhere',
  );
  assert.throws(
    () => buildEvent({ type: 'assignment.failed', label: 'Build', desk: 'operations' }),
    /needs "reason"/,
    'a failure without a reason tells a viewer nothing',
  );
  assert.throws(
    () => buildEvent({ type: 'specialist.joined', label: 'Someone arrived', worker: 'agent:x' }),
    /needs "role"/,
  );
  assert.throws(
    () => buildEvent({ type: 'artifact.created', label: 'Wrote it', desk: 'workshop' }),
    /artifact:\{id,name,kind\}/,
  );
  assert.throws(
    () => buildEvent({ type: 'assignment.started', label: 'Reading', desk: 'planning' }),
    /unknown station "planning"/,
    'a desk that does not exist renders nowhere at all',
  );
});

test('emit builds a contract-shaped event from plain command-line arguments', () => {
  const event = buildEvent({
    type: 'assignment.started',
    label: 'Reading the spec',
    desk: 'reading',
    worker: 'agent:planner',
    detail: 'src/spec.md',
  });
  assert.deepEqual(event, {
    type: 'assignment.started',
    label: 'Reading the spec',
    station: 'reading',
    worker: 'agent:planner',
    detail: 'src/spec.md',
  });
});

test('emit stays quiet when no bridge is listening', async () => {
  // The office being down must never break the work it is watching — the same reason the
  // Claude Code hooks all end in `|| true`.
  const result = await sendEvent({
    event: { type: 'note', label: 'x' },
    url: 'http://127.0.0.1:9',
    token: 'irrelevant',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(result.offline, true);
  assert.equal(result.ok, false);
});

test('the merge itself is pure — it never mutates the settings handed to it', () => {
  // connectProject touches a real disk; this is the part worth reasoning about, so it is
  // separable and side-effect free.
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } };
  const frozen = JSON.stringify(original);

  const { settings, added, replaced } = mergeHooks(original, HOOKS);

  assert.equal(JSON.stringify(original), frozen, 'the input was not modified');
  assert.equal(settings.hooks.Stop.length, 2, 'theirs kept, ours added');
  assert.deepEqual(added.sort(), ['PreToolUse', 'Stop']);
  assert.deepEqual(replaced, [], 'nothing of ours was there to replace');
});

test('an event from another runtime is not recorded as Claude Code', async () => {
  // /event exists so Codex, Replit and hand-rolled loops can report. Stamping their work
  // 'claude-code' puts one tool's output under another's name — a lie about provenance in
  // a product whose subject is not misrepresenting what happened.
  await withBridge(async ({ bridge, url }) => {
    await fetch(url('/event'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': TOKEN },
      body: JSON.stringify({ type: 'note', label: 'Reported by some other agent' }),
    });
    const event = bridge.events.at(-1);
    assert.equal(event.source, 'external', 'unattributed events are external, not claude-code');
    assert.ok(isOfficeEvent(event), 'and still satisfy the contract');
  });
});

test('a producer that names its own source keeps it', async () => {
  await withBridge(async ({ bridge, url }) => {
    await fetch(url('/event'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': TOKEN },
      body: JSON.stringify({ type: 'note', label: 'Mine', source: 'claude-code' }),
    });
    assert.equal(bridge.events.at(-1).source, 'claude-code');
  });
});

test('the door and the renderer agree about every event in the fixtures', () => {
  // bridge/contract.mjs mirrors lib/office-view/core/events.ts because a plain-Node server
  // cannot import a .ts module. A mirror that drifts is worse than no mirror, so this
  // walks every committed recording through both and requires the same verdict.
  const fixtures = ['recorded-lead-run.json', 'recorded-coding-run.json'];
  let checked = 0;

  for (const name of fixtures) {
    const url = new URL(`../fixtures/${name}`, import.meta.url);
    const { events } = JSON.parse(readFileSync(url, 'utf8'));
    for (const event of events) {
      const doorSaysFine = describeProblems(event).length === 0;
      const rendererSaysFine = isOfficeEvent(event);
      assert.equal(
        doorSaysFine,
        rendererSaysFine,
        `${name} ${event.type} (${event.id}): door=${doorSaysFine} renderer=${rendererSaysFine}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 500, `only ${checked} events checked — the fixtures look wrong`);
});

test('the door knows every desk a producer is allowed to name', () => {
  /*
   * The station list is hard-coded in server.mjs because the plan is a .ts module. If a
   * department is added to the plan, this fails rather than the door quietly rejecting
   * real work.
   *
   * It compares against DEPARTMENTS, not against every station. A department now owns
   * several desks so that concurrent agents each get their own, but only the department's
   * own id is addressable: producers name the KIND of work they are doing, and which desk
   * that becomes is the office's business. A producer that could target `operations-3`
   * would be choosing seating, which it has no way to reason about.
   */
  const addressable = codingSessionPlan.stations
    .filter((station) => !station.satellite)
    .map((station) => station.id)
    .sort();
  assert.deepEqual(
    [...DESKS].sort(),
    addressable,
    'the desks emit knows must match the departments a producer may name',
  );

  const satellites = codingSessionPlan.stations.filter((station) => station.satellite);
  assert.ok(satellites.length > 0, 'departments have room for concurrent agents');
  for (const satellite of satellites) {
    assert.equal(
      [...DESKS].includes(satellite.id),
      false,
      `${satellite.id} is seating, not an address a producer may aim at`,
    );
  }
});

test('the contract is published so an agent can correct itself', async () => {
  await withBridge(async ({ url }) => {
    const res = await fetch(url('/contract'));
    assert.equal(res.status, 200, 'deliberately unauthenticated — it is a schema, not session data');
    const contract = await res.json();
    assert.ok(contract.events['artifact.created'].requires.length > 0);
    assert.ok(contract.stations.includes('workshop'));
    assert.ok(
      contract.rules.some((rule) => /literal/i.test(rule)),
      'the honesty rules travel with the schema, not just in prose',
    );
  });
});

/* --- one place that says what this office is -------------------------------- */

test('office config layers env over file over defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'o6-config-'));
  try {
    writeFileSync(
      join(root, 'office.config.json'),
      JSON.stringify({ name: 'Someone Else Office', bridge: { port: 4200 } }),
    );
    // A personal override that is not committed, and does not have to exist.
    writeFileSync(join(root, 'office.config.local.json'), JSON.stringify({ bridge: { port: 4300 } }));

    const config = loadOfficeConfig({ root, env: { O6_BRIDGE_PORT: '4400' } });
    assert.equal(config.bridge.port, 4400, 'env wins');
    assert.equal(config.name, 'Someone Else Office', 'file wins over the default');
    assert.equal(config.bridge.maxEvents, 5000, 'and the default stands where nobody spoke');

    const noEnv = loadOfficeConfig({ root, env: {} });
    assert.equal(noEnv.bridge.port, 4300, 'the local file wins over the committed one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing config file is normal; a broken one is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'o6-config-'));
  try {
    // Nothing at all: every default applies, silently. That is what makes the `.local.`
    // override usable without every checkout needing one.
    assert.equal(loadOfficeConfig({ root, env: {} }).bridge.port, 4141);

    // Present but broken is a mistake worth stopping for, unlike absent.
    writeFileSync(join(root, 'office.config.json'), '{ not json');
    assert.throws(() => loadOfficeConfig({ root, env: {} }), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonsense knobs fall back wherever they came from', () => {
  const root = mkdtempSync(join(tmpdir(), 'o6-config-'));
  try {
    // A negative cap is a typo, not a preference. Honouring it from a FILE would produce
    // an office that silently keeps no events — the env path was already guarded, the
    // file path was not until a test caught it.
    writeFileSync(join(root, 'office.config.json'), JSON.stringify({ bridge: { maxEvents: -5 } }));
    assert.equal(loadOfficeConfig({ root, env: {} }).bridge.maxEvents, 5000);
    assert.equal(loadOfficeConfig({ root, env: { O6_BRIDGE_PORT: 'banana' } }).bridge.port, 4141);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --- the setup wizard ---------------------------------------------------------
 *
 * The wizard's value is not the merging — `connect` already did that. It is that it
 * finishes by PROVING the wiring, because Claude Code fires hooks only when it next does
 * something, so a botched setup and a correct one look identical until you have run a
 * session and stared at an empty office wondering which you were looking at.
 */

test('the survey reports what is there without changing any of it', () => {
  const root = mkdtempSync(join(tmpdir(), 'o6-survey-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
  );

  const survey = surveyProject({ root, port: 4141 });
  assert.equal(survey.hasClaudeDir, true);
  assert.equal(survey.hasSettings, true);
  assert.equal(survey.settingsUnreadable, false);
  assert.deepEqual(survey.connectedEvents, [], 'nothing of ours is wired yet');
  assert.deepEqual(survey.foreignEvents, ['SessionStart'], 'and their hook is seen, not ignored');
});

test('a settings file we cannot parse stops the wizard rather than being overwritten', () => {
  /*
   * The one case where doing nothing is the only safe move. Rewriting a file we cannot
   * read would destroy configuration that is not ours, to fix a visualisation.
   */
  const root = mkdtempSync(join(tmpdir(), 'o6-broken-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), '{ this is not json');

  const survey = surveyProject({ root, port: 4141 });
  assert.equal(survey.settingsUnreadable, true);

  const steps = planSteps(survey);
  assert.equal(steps.length, 1, 'it plans one thing: stopping');
  assert.equal(steps[0].blocked, true);
  assert.match(steps[0].detail, /not valid JSON/);
});

/** A hook command shaped exactly like the one the CLI writes. */
const hookCommandFor = (url, token) =>
  `curl -s -m 2 -X POST ${url}/hook -H "Content-Type: application/json" ` +
  `-H "x-o6-token: ${token}" --data-binary @- >/dev/null || true`;

const projectWiredTo = (url, token) => {
  const root = mkdtempSync(join(tmpdir(), 'o6-wired-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookCommandFor(url, token) }] }] },
    }),
  );
  return root;
};

test('the plan says what is already done rather than hiding it', () => {
  // Re-running setup should tell you that you were already set up, not leave you
  // wondering whether it took.
  const root = projectWiredTo('http://127.0.0.1:4141', 'the-same-token');
  const survey = surveyProject({
    root,
    port: 4141,
    url: 'http://127.0.0.1:4141',
    token: 'the-same-token',
  });
  assert.deepEqual(survey.connectedEvents, ['PreToolUse'], 'ours is recognised by its endpoint');
  assert.equal(survey.wiringMatches, true);

  const hooks = planSteps(survey).find((step) => step.id === 'hooks');
  assert.equal(hooks.needed, false);
  assert.match(hooks.detail, /Already wired/);
});

test('hooks wired to a different token or port are refreshed, not called done', () => {
  /*
   * The failure the whole command exists to prevent, which the first version walked into.
   * The token is regenerated on every run unless O6_BRIDGE_TOKEN is set, so a second run
   * left the previous token in settings.json, announced "already wired", and every real
   * hook then got a silent 401 — silent because the hook command ends in `|| true`, so a
   * broken office never interrupts the work it is meant to be showing.
   */
  const cases = [
    ['token', 'http://127.0.0.1:4141', 'last-weeks-token', 'http://127.0.0.1:4141', 'todays-token'],
    ['port', 'http://127.0.0.1:4311', 'same-token', 'http://127.0.0.1:4141', 'same-token'],
  ];
  for (const [label, wasUrl, wasToken, nowUrl, nowToken] of cases) {
    const root = projectWiredTo(wasUrl, wasToken);
    const survey = surveyProject({ root, port: 4141, url: nowUrl, token: nowToken });

    assert.deepEqual(survey.wiredTo, { url: wasUrl, token: wasToken }, `${label}: read off disk`);
    assert.equal(survey.wiringMatches, false, `${label}: recognised as not this bridge`);

    const hooks = planSteps(survey).find((step) => step.id === 'hooks');
    assert.equal(hooks.needed, true, `${label}: so the hooks are rewritten`);
    assert.match(hooks.detail, /will refresh/i, `${label}: and it says so`);
  }
});

test('a project keeping its own scripts in .claude/hooks is not read as connected', () => {
  /*
   * The old marker was the four characters `/hook`, which is also a substring of `/hooks/`
   * — the conventional directory a project keeps its hook scripts in. So a project running
   * `bash .claude/hooks/format.sh` read as already connected to the office, and setup
   * skipped wiring anything at all while still reporting success.
   */
  const root = mkdtempSync(join(tmpdir(), 'o6-theirs-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: 'bash .claude/hooks/format.sh' }] }],
      },
    }),
  );

  const survey = surveyProject({ root, port: 4141, url: 'http://127.0.0.1:4141', token: 'a-token' });
  assert.deepEqual(survey.connectedEvents, [], 'their script is not our hook');
  assert.deepEqual(survey.foreignEvents, ['PostToolUse'], 'and it is seen, so it survives');

  const hooks = planSteps(survey).find((step) => step.id === 'hooks');
  assert.equal(hooks.needed, true, 'so setup actually wires the office up');
});

test('the check replays the wiring on disk, so a stale token fails honestly', async () => {
  /*
   * The old check POSTed with the token this process was holding, so it could not fail for
   * a token mismatch however wrong settings.json was — it verified the bridge, not the
   * wiring, which is the same shortcut the command exists to catch.
   */
  await withBridge(async ({ port, url }) => {
    const good = await verifyRoundTrip({
      port,
      token: TOKEN,
      wiredTo: { url: url(''), token: TOKEN },
      timeoutMs: 4000,
    });
    assert.equal(good.ok, true, `matching wiring should pass: ${good.reason}`);

    const stale = await verifyRoundTrip({
      port,
      token: TOKEN,
      wiredTo: { url: url(''), token: 'the-token-from-last-week' },
      timeoutMs: 2500,
    });
    assert.equal(stale.ok, false, 'a stale token on disk must not pass');
    assert.match(stale.reason, /token your hooks are using/, 'and must say what is wrong');
  });
});

test('the check pushes an event down the real path and waits for it on the real stream', async () => {
  /*
   * The point of the whole command. It POSTs a Claude-Code-shaped payload to /hook and
   * waits for it on /events — the exact stream the office subscribes to. A check that
   * called an internal function instead would pass while the thing people need was broken.
   */
  await withBridge(async ({ port }) => {
    const result = await verifyRoundTrip({ port, token: TOKEN, timeoutMs: 4000 });
    assert.equal(result.ok, true, `round trip failed: ${result.reason}`);
  });
});

test('the check fails honestly when the token is wrong', async () => {
  await withBridge(async ({ port }) => {
    const result = await verifyRoundTrip({ port, token: 'not-the-right-token-at-all', timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /refused/, 'and says which end refused it');
  });
});

test('a stream opened before anything has happened connects immediately', async () => {
  /*
   * The first-run case, and it used to hang. writeHead only stages headers; Node sends
   * nothing until the first write, and a bridge with no events had nothing to replay — so
   * the office sat on "Connecting…" until either the agent did something or the 25-second
   * keep-alive fired. Indistinguishable, for 25 seconds, from a broken setup.
   */
  await withBridge(async ({ url }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const stream = await fetch(url(`/events?token=${TOKEN}`), {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      assert.equal(stream.status, 200, 'the headers arrive without waiting for an event');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});

test('merging never deletes a hook of theirs that merely mentions hooks', () => {
  /*
   * The worst bug this tool could have, and it had it. The marker was the four characters
   * `/hook`, which is also inside `/hooks/` — the conventional directory a project keeps
   * its own hook scripts in — so `bash .claude/hooks/format.sh` was classified as OURS and
   * dropped on merge. Silently destroying somebody's configuration in order to install a
   * visualisation, three lines under a comment promising not to.
   *
   * Caught by running the wizard for real against a project that had one, not by a test.
   */
  const theirs = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'bash .claude/hooks/format.sh' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'node ./scripts/hooks/audit.js' }] }],
    },
  };
  const ours = {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommandFor('http://127.0.0.1:4141', 'tok') }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: hookCommandFor('http://127.0.0.1:4141', 'tok') }] }],
  };

  const { settings, kept } = mergeHooks(theirs, ours);
  const text = JSON.stringify(settings);
  assert.ok(text.includes('format.sh'), 'their SessionStart script survived');
  assert.ok(text.includes('audit.js'), 'their PreToolUse script survived');
  assert.equal(kept.length, 2, 'and the report says both were kept');
});

test('merging replaces our own hook rather than stacking a second copy', () => {
  // The other half: re-running must not leave two of ours posting the same event twice.
  const already = {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: hookCommandFor('http://127.0.0.1:4311', 'old') }] },
      ],
    },
  };
  const ours = {
    PreToolUse: [{ hooks: [{ type: 'command', command: hookCommandFor('http://127.0.0.1:4141', 'new') }] }],
  };

  const { settings, replaced } = mergeHooks(already, ours);
  const entries = settings.hooks.PreToolUse;
  assert.equal(entries.length, 1, 'one of ours, not two');
  assert.ok(JSON.stringify(entries).includes('4141'), 'and it is the current one');
  assert.deepEqual(replaced, ['PreToolUse']);
});

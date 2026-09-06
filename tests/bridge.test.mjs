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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBridge } from '../bridge/server.mjs';
import { loadConfig, requireToken, suggestToken } from '../bridge/config.mjs';
import { TranscriptWatcher, readSessionUsage, subagentsDirFor } from '../bridge/transcript.mjs';
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

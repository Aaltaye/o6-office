#!/usr/bin/env node
/**
 * replay-hooks — post a captured session's hooks at a running bridge.
 *
 * An end-to-end check of the real path: the same payload shapes Claude Code sends, over
 * HTTP, through the real token check, the real mapping, and out of the real SSE stream.
 * Unit tests cover each piece; this covers the seams between them.
 *
 * Usage:
 *   node scripts/replay-hooks.mjs --token <token> [--port 4141] [--limit 400] [--speed 40]
 */

import { readFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const token = arg('token', process.env.O6_BRIDGE_TOKEN);
if (!token) throw new Error('Pass --token (or set O6_BRIDGE_TOKEN).');

const port = Number(arg('port', 4141));
const limit = Number(arg('limit', 0)) || Infinity;
/** Wall-clock compression: 40 means a 40-minute session replays in about a minute. */
const speed = Number(arg('speed', 40));
const file = arg('in', 'fixtures/captured-coding-session.json');

const capture = JSON.parse(readFileSync(file, 'utf8'));
const hooks = capture.events.filter((event) => event.hook_event_name).slice(0, limit);

process.stdout.write(`Replaying ${hooks.length} hooks at ${speed}x into 127.0.0.1:${port}\n`);

let previous = hooks[0]?.occurred_at ?? 0;
let sent = 0;
let rejected = 0;

for (const hook of hooks) {
  // Preserve the shape of the original pacing rather than firing everything at once —
  // the point is to exercise the bridge the way a session actually drives it.
  const wait = Math.min((hook.occurred_at - previous) / speed, 400);
  previous = hook.occurred_at;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  try {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-o6-token': token },
      body: JSON.stringify(hook),
    });
    if (response.ok) sent += 1;
    else rejected += 1;
  } catch {
    rejected += 1;
  }
}

process.stdout.write(`Done. ${sent} accepted, ${rejected} rejected.\n`);

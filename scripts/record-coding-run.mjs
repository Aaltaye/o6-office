#!/usr/bin/env node
/**
 * record-coding-run — turn the captured Claude Code session into a replayable run.
 *
 * The lead-workflow demo shows the office doing business work. This one shows it doing
 * *your* work, and it is the honest half of the "connect your work" claim: a real session
 * really did these things, in this order, at these intervals.
 *
 * The provenance chain is stated in the fixture rather than implied:
 *   a real session's transcripts
 *     -> reconstructed hook payloads (scripts/capture-session.mjs, redacted)
 *     -> OfficeEvents (bridge/map-claude-code.mjs, the same mapping the live bridge uses)
 *
 * The middle step is a reconstruction, not a live hook capture, and this says so. What is
 * real: the tools, their order, their timing, the failures, and the subagent.
 *
 * Usage: node --experimental-strip-types scripts/record-coding-run.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { mapHook } from '../bridge/map-claude-code.mjs';
import { createEmitter, isOfficeEventStream } from '../lib/office-view/core/events.ts';
import { compileFloorPlan } from '../lib/office-view/core/plan.ts';
import { schedule } from '../lib/office-view/core/scheduler.ts';
import { codingSessionPlan } from '../lib/floorplans/coding-session.ts';

const inIndex = process.argv.indexOf('--in');
const outIndex = process.argv.indexOf('--out');
const input = inIndex > -1 ? process.argv[inIndex + 1] : 'fixtures/captured-coding-session.json';
const out = outIndex > -1 ? process.argv[outIndex + 1] : 'fixtures/recorded-coding-run.json';

const capture = JSON.parse(readFileSync(input, 'utf8'));
const emit = createEmitter('recorded-coding-run');
const events = [];
const state = { currentPromptId: null, workLabels: {} };
const ignored = new Map();

for (const payload of capture.events) {
  // Usage records are the transcript's job, not the mapping's. They are carried over
  // separately below so the meter still shows real numbers.
  if (!payload.hook_event_name) continue;

  const result = mapHook(payload, state);
  if (result.ignored) ignored.set(result.ignored, (ignored.get(result.ignored) ?? 0) + 1);
  if (result.setWork) {
    state.currentPromptId = result.setWork.id;
    state.workLabels[result.setWork.id] = result.setWork.label;
  }
  for (const event of result.events) {
    events.push(emit({ ...event, source: 'claude-code', occurredAt: payload.occurred_at }));
  }
}

// Usage, from the transcript records the capture carried, attributed per subagent.
for (const record of capture.events) {
  if (record.record !== 'usage') continue;
  events.push(
    emit({
      type: 'usage.reported',
      source: 'claude-code',
      occurredAt: record.occurred_at,
      label: record.agent_id ? 'Subagent usage' : 'Session usage',
      usage: {
        source: 'transcript',
        worker: record.agent_id ? `agent:${record.agent_id}` : undefined,
        model: record.model,
        inputTokens: (record.input_tokens ?? 0) + (record.cache_creation_input_tokens ?? 0),
        cachedInputTokens: record.cache_read_input_tokens ?? 0,
        outputTokens: record.output_tokens ?? 0,
      },
    }),
  );
}

events.sort((a, b) => a.occurredAt - b.occurredAt || a.seq - b.seq);

// Refuse to ship a fixture that would not render, or that misses the point.
if (!isOfficeEventStream(events)) throw new Error('recorded stream failed contract validation');

const timeline = schedule(events, compileFloorPlan(codingSessionPlan));
if (timeline.violations.length > 0) {
  throw new Error(`recorded run violates scheduling invariants:\n${timeline.violations.join('\n')}`);
}
const specialists = events.filter((e) => e.type === 'specialist.joined');
if (specialists.length === 0) {
  throw new Error('recorded run contains no subagent — the demo would not show the beat');
}

const usageTotal = events
  .filter((e) => e.type === 'usage.reported')
  .reduce((sum, e) => sum + (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0), 0);

const fixture = {
  v: 1,
  kind: 'recorded-run',
  plan: 'coding-session',
  recordedAt: new Date().toISOString(),
  provenance:
    'A real Claude Code session. Its transcripts were reconstructed into hook payloads ' +
    '(redacted), then mapped by the same bridge mapping the live bridge uses. The tools, ' +
    'their order, their timing, the failures and the subagent are real; the hook payloads ' +
    'were reconstructed from transcripts rather than captured live, and content is redacted.',
  sourceCapture: { file: input, sessionId: capture.sessionId, redacted: capture.redacted },
  durationMs: timeline.duration,
  events,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);

const counts = {};
for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;

process.stdout.write(
  `Wrote ${out}\n` +
    `  events:          ${events.length}\n` +
    `  replay duration: ${(timeline.duration / 1000).toFixed(1)}s\n` +
    `  subagents:       ${specialists.length}\n` +
    `  tokens reported: ${usageTotal.toLocaleString()} (from transcript)\n` +
    `  by type:         ${JSON.stringify(counts)}\n` +
    `  hooks skipped:   ${JSON.stringify(Object.fromEntries(ignored))}\n`,
);

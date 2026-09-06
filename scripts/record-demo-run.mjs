#!/usr/bin/env node
/**
 * record-demo-run — capture a real run of the lead workflow as a replayable fixture.
 *
 * This is what a first-time visitor watches. It matters that it is a genuine recording:
 * the office's whole claim is that what you see is what happened, and a hand-authored
 * "demo" would quietly break that on the very first thing anyone sees.
 *
 * So this runs the actual workflow over the actual fictional sample data, with the real
 * qualification rules and the real local reviewer, and writes whatever it emits. The
 * carried-back beat appears in the recording because it genuinely occurs: the template
 * draft references nothing the contact said, the reviewer rejects it, and the redraft is
 * rewritten around a quote from the record.
 *
 * The sample records are fictional (see SAMPLE_CSV) — the run is real, the people are not.
 *
 * Usage: node scripts/record-demo-run.mjs [--out fixtures/recorded-lead-run.json]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { runLeadWorkflow } from '../lib/lead-workflow.ts';
import { parseCSV, deduplicate, SAMPLE_CSV, SAMPLE_DATE, DEFAULT_OFFER } from '../lib/lead-engine.ts';
import { createEmitter, isOfficeEventStream } from '../lib/office-view/core/events.ts';
import { compileFloorPlan } from '../lib/office-view/core/plan.ts';
import { schedule } from '../lib/office-view/core/scheduler.ts';
import { leadReactivationPlan } from '../lib/floorplans/lead-reactivation.ts';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > -1 ? process.argv[outIndex + 1] : 'fixtures/recorded-lead-run.json';

const input = parseCSV(SAMPLE_CSV);
const leads = deduplicate(input);
const emit = createEmitter('recorded-lead-run');
const events = [];

/**
 * Timestamps advance by the pacing the workflow asks for, rather than by wall clock.
 * A recording made on a fast machine and one made on a slow machine should replay
 * identically — the run's shape is the data, the machine is not.
 */
let now = 0;
const wait = async (ms) => {
  now += ms;
};

const result = await runLeadWorkflow(
  { leads, offer: DEFAULT_OFFER, date: SAMPLE_DATE, recordCount: input.length },
  {
    emit: (event) => {
      now += 40; // a small step so events in one phase are ordered but near-simultaneous
      events.push(emit({ ...event, source: 'lead-workflow', occurredAt: now }));
    },
    updateLead: () => {},
    wait,
  },
);

// Refuse to write a fixture that would not render. A broken demo is worse than none.
if (!isOfficeEventStream(events)) throw new Error('recorded stream failed contract validation');

const timeline = schedule(events, compileFloorPlan(leadReactivationPlan));
if (timeline.violations.length > 0) {
  throw new Error(`recorded run violates scheduling invariants:\n${timeline.violations.join('\n')}`);
}

// The recording is only worth shipping if the beat it is meant to show actually occurred.
const backward = events.filter((e) => e.type === 'handoff' && e.direction === 'backward');
if (backward.length === 0) {
  throw new Error('recorded run contains no carried-back handoff — the demo would not show the beat');
}

const fixture = {
  v: 1,
  kind: 'recorded-run',
  recordedAt: new Date().toISOString(),
  plan: 'lead-reactivation',
  provenance:
    'A real run of the lead workflow over the built-in fictional sample data, in local-rules mode. ' +
    'No model calls were made, so the run reports no specialists and no usage. The contacts are invented; the run is not.',
  status: result.status,
  uniqueLeads: result.uniqueLeads,
  durationMs: timeline.duration,
  events,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);

const counts = {};
for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;

process.stdout.write(
  `Wrote ${out}\n` +
    `  events:            ${events.length}\n` +
    `  unique leads:      ${result.uniqueLeads}\n` +
    `  replay duration:   ${(timeline.duration / 1000).toFixed(1)}s\n` +
    `  carried back:      ${backward.length}\n` +
    `  by type:           ${JSON.stringify(counts)}\n`,
);

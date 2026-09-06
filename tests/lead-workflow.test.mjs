/**
 * T003 — the workflow as a producer of OfficeEvent.
 *
 * These are the honesty tests. The office animates whatever this stream says, so a bug
 * here is not a rendering glitch — it is the visualisation asserting something that did
 * not happen. Every rule the office claims to follow is checked against a real run of
 * the real engine over the real sample data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runLeadWorkflow } from '../lib/lead-workflow.ts';
import { reviewDraft, groundedDraft } from '../lib/lead-review.ts';
import {
  parseCSV,
  deduplicate,
  draftTemplate,
  SAMPLE_CSV,
  SAMPLE_DATE,
  DEFAULT_OFFER,
} from '../lib/lead-engine.ts';
import { isOfficeEvent, createEmitter } from '../lib/office-view/core/events.ts';
import { compileFloorPlan } from '../lib/office-view/core/plan.ts';
import { leadReactivationPlan } from '../lib/floorplans/lead-reactivation.ts';
import { schedule } from '../lib/office-view/core/scheduler.ts';

const rows = () => parseCSV(SAMPLE_CSV);

/**
 * Run the workflow headlessly and collect the full envelope-complete stream, exactly as
 * the hook would build it.
 */
async function runSample({ live = false, concurrency = 2 } = {}) {
  const input = rows();
  const leads = deduplicate(input);
  const emit = createEmitter('run-test');
  const events = [];
  const updated = new Map();

  const result = await runLeadWorkflow(
    { leads, offer: DEFAULT_OFFER, date: SAMPLE_DATE, recordCount: input.length },
    {
      emit: (event) =>
        events.push(emit({ ...event, source: 'lead-workflow', occurredAt: events.length * 10 })),
      updateLead: (id, patch) => updated.set(id, { ...updated.get(id), ...patch }),
      wait: async () => {},
      concurrency,
      callAgent: live
        ? async (task) => ({
            output:
              task === 'review'
                ? { approved: true, review_note: 'Looks supported by the notes.' }
                : task === 'draft'
                  ? { subject: 'S', draft: 'A drafted message.', evidence: [] }
                  : { summary: 'A summary.', evidence: [] },
            usage: { input: 100, output: 20, estimatedCost: 0.0001, model: 'test-model' },
          })
        : undefined,
    },
  );

  return { events, result, leads, updated };
}

const typesIn = (events, type) => events.filter((e) => e.type === type);

test('every event a real run emits is valid against the contract', async () => {
  const { events } = await runSample();
  assert.ok(events.length > 50, `expected a substantial stream, got ${events.length}`);
  for (const event of events) {
    assert.equal(isOfficeEvent(event), true, `invalid event: ${JSON.stringify(event).slice(0, 200)}`);
  }
});

test('the run opens and closes, and says what it processed', async () => {
  const { events, result } = await runSample();
  assert.equal(events[0].type, 'run.started');
  assert.equal(events.at(-1).type, 'run.finished');
  assert.equal(events.at(-1).outcome, 'completed');
  assert.equal(result.status, 'completed');
  // The sample is 10 records that merge to 9 unique leads.
  assert.equal(result.uniqueLeads, 9);
  assert.equal(typesIn(events, 'work.received').length, 9);
});

test('local-rules mode reports no specialists and no usage', async () => {
  // The central honesty rule. Nothing was called in and nothing was spent, so animating
  // either would be a lie — and a zero-cost meter would read as "this was free".
  const { events } = await runSample({ live: false });
  assert.equal(typesIn(events, 'specialist.joined').length, 0);
  assert.equal(typesIn(events, 'specialist.left').length, 0);
  assert.equal(typesIn(events, 'usage.reported').length, 0);

  const note = events.find((e) => e.type === 'note');
  assert.match(note.detail, /no model calls/, 'the run should say why there are none');
});

test('live mode reports a specialist per assignment, with usage that states its source', async () => {
  const { events } = await runSample({ live: true });
  const joined = typesIn(events, 'specialist.joined');
  const left = typesIn(events, 'specialist.left');
  assert.ok(joined.length > 0, 'live mode should call specialists in');
  assert.equal(joined.length, left.length, 'every specialist that joins must also leave');

  for (const event of typesIn(events, 'usage.reported')) {
    assert.equal(event.usage.source, 'provider-response');
    assert.ok(event.usage.worker, 'usage should be attributed to the specialist that spent it');
    assert.ok(event.usage.inputTokens > 0);
  }
});

test('excluded and held leads state a reason', async () => {
  // Work leaving the line is as important to show as work completing, and the office
  // must be able to say why rather than just dropping the folder.
  const { events } = await runSample();
  const blocked = typesIn(events, 'blocked');
  assert.ok(blocked.length > 0, 'the sample contains opt-outs and not-yet-due follow-ups');
  for (const event of blocked) {
    assert.ok(event.waitingOn && event.waitingOn.length > 5, `no stated reason: ${event.label}`);
  }
});

test('every handoff declares its direction and both endpoints', async () => {
  const { events } = await runSample();
  const handoffs = typesIn(events, 'handoff');
  assert.ok(handoffs.length > 0);
  for (const event of handoffs) {
    assert.ok(['forward', 'backward'].includes(event.direction));
    assert.ok(event.from, 'a handoff must say where it came from');
    assert.ok(event.to, 'a handoff must say where it went');
    assert.notEqual(event.from, event.to, 'a handoff to the same place is not a handoff');
  }
});

test('the reviewer genuinely sends work back, and the rework genuinely fixes it', async () => {
  // The flagship beat. It must be real: a review that actually failed, a redraft that
  // actually addressed the objection, and a handoff that declares it went backward.
  const { events } = await runSample();

  const failures = typesIn(events, 'assignment.failed');
  assert.ok(failures.length > 0, 'the generic template should fail review on the sample data');
  assert.match(failures[0].reason, /does not reference anything this contact actually said/);

  const backward = typesIn(events, 'handoff').filter((e) => e.direction === 'backward');
  assert.ok(backward.length > 0, 'a failed review must carry the work back');
  assert.equal(backward[0].to, 'outreach');
  assert.ok(backward[0].reason, 'the carried-back folder must carry the reason with it');

  // And the rework actually happened, producing a second, different artifact.
  const revised = typesIn(events, 'artifact.created').filter((e) => e.label === 'Draft revised');
  assert.ok(revised.length > 0, 'the rework must produce a revised draft');
});

test('a reworked draft passes the same check that rejected the first one', async () => {
  // Otherwise the loop would be theatre: work goes back and returns just as deficient.
  const leads = deduplicate(rows());
  const ready = leads.find((l) => l.sources.some((s) => s.notes.trim().length > 30));
  assert.ok(ready, 'sample should contain a lead with substantive notes');

  const first = draftTemplate(ready, DEFAULT_OFFER);
  const firstReview = reviewDraft(ready, first.draft, DEFAULT_OFFER);
  assert.equal(firstReview.approved, false, 'the generic template should be rejected');

  const second = groundedDraft(ready, DEFAULT_OFFER);
  const secondReview = reviewDraft(ready, second.draft, DEFAULT_OFFER);
  assert.equal(secondReview.approved, true, 'the grounded rewrite should pass');
  assert.ok(secondReview.grounding.length > 0);

  // The fix is real: the rewrite quotes the record, and cites which row it came from.
  assert.match(second.draft, /you mentioned/);
  assert.ok(second.evidence.some((e) => /^Row \d+:/.test(e)));
});

test('the reviewer does not fail a lead that supplied no history to reference', async () => {
  // Approving here is honest: the draft is as grounded as the record allows, and
  // demanding a reference to notes that do not exist would be a fabricated objection.
  const lead = { ...deduplicate(rows())[0], sources: [{ notes: '', row: 2 }] };
  const outcome = reviewDraft(lead, 'Hi there, following up.', DEFAULT_OFFER);
  assert.equal(outcome.approved, true);
  assert.match(outcome.reason, /No conversation history/);
});

test('offer wording alone does not count as referencing the history', async () => {
  // Otherwise a sender could pass the check with their own boilerplate, and the office
  // would show an approval that was never earned.
  const lead = deduplicate(rows()).find((l) => l.sources.some((s) => s.notes.includes('inquiry')));
  assert.ok(lead);
  const offer = lead.sources.map((s) => s.notes).join(' ');
  const outcome = reviewDraft(lead, `Hello. ${offer}`, offer);
  assert.equal(outcome.approved, false, 'words contributed by the offer must be excluded');
});

test('finished work reaches the outbox; held work does not', async () => {
  const { events } = await runSample();
  const toOutbox = typesIn(events, 'handoff').filter((e) => e.to === 'outbox');
  assert.ok(toOutbox.length > 0, 'the sample has leads that should finish');
  // The sample yields 2 ready leads; both should end in the outbox after rework.
  assert.equal(toOutbox.length, 2);
});

test('the emitted stream schedules onto the real floor plan without violations', async () => {
  // The producer and the renderer have to actually agree: every station this workflow
  // names must exist on the plan, and the scheduler's invariants must hold.
  const { events } = await runSample();
  const compiled = compileFloorPlan(leadReactivationPlan);
  const timeline = schedule(events, compiled);
  assert.deepEqual(timeline.violations, []);
  assert.ok(timeline.duration > 0);

  const stations = new Set(leadReactivationPlan.stations.map((s) => s.id));
  for (const event of events) {
    if ('station' in event) {
      assert.ok(stations.has(event.station), `unknown station: ${event.station}`);
    }
  }
});

test('a completed run serialises and survives a round trip', async () => {
  // Replay is the public demo, so a run has to be storable as plain JSON and come back
  // valid — otherwise a recorded demo is not evidence of anything.
  const { events } = await runSample();
  const restored = JSON.parse(JSON.stringify(events));
  assert.equal(restored.length, events.length);
  for (const event of restored) assert.equal(isOfficeEvent(event), true);
});

test('running one lead at a time produces the same set of events as running two', async () => {
  // Concurrency changes interleaving, not what happened. If it changed the content, the
  // office would be showing an artefact of scheduling rather than the work.
  const serial = await runSample({ concurrency: 1 });
  const parallel = await runSample({ concurrency: 2 });

  const shape = (events) =>
    events
      .map((e) => `${e.type}:${e.work?.id ?? e.station ?? ''}`)
      .sort()
      .join('|');
  assert.equal(shape(serial.events), shape(parallel.events));
});

/**
 * office-view/dev/demo-stream — hand-written event streams for developing the renderer.
 *
 * These exist so the office is provable *before* any workflow is wired into it, and so
 * the awkward cases have a home: a reviewer sending work back, a specialist arriving and
 * leaving, and a burst of genuinely simultaneous handoffs.
 *
 * **These are synthetic and say so.** The real captured session
 * (`fixtures/captured-coding-session.json`) supplies realistic *pacing* but almost no
 * parallelism — that session issued few parallel tool calls, so its largest simultaneous
 * group is 3. Rather than pretend the real capture exercises the burst path, the burst
 * case gets its own clearly-synthetic stream. A fixture that quietly overstates what it
 * proves is exactly the failure this project is built to avoid.
 */

import type { OfficeEvent } from '../core/types.ts';
import { createEmitter } from '../core/events.ts';

const LEADS = [
  { id: 'lead-1', label: 'Harbor & Pine' },
  { id: 'lead-2', label: 'Northline Print' },
  { id: 'lead-3', label: 'Cedar Supply' },
  { id: 'lead-4', label: 'Elm Street Fitness' },
  { id: 'lead-5', label: 'Westhaven Repairs' },
  { id: 'lead-6', label: 'Juniper Events' },
];

/**
 * A full pass through the office, including the flagship beat.
 *
 * The shape mirrors the real lead workflow: work arrives, moves through the departments,
 * some of it is held with a stated reason, a bounded specialist is called in, the
 * reviewer sends one draft back, and the finished work lands in the outbox.
 */
export function demoLeadRun(): OfficeEvent[] {
  const emit = createEmitter('demo-lead-run');
  const events: OfficeEvent[] = [];
  const push = (input: Parameters<typeof emit>[0]) => events.push(emit(input));

  let t = 0;
  const step = (ms = 900) => (t += ms);

  push({ type: 'run.started', occurredAt: t, source: 'fixture', label: 'The office opens', plan: 'lead-reactivation' });

  for (const lead of LEADS) {
    push({ type: 'work.received', occurredAt: step(180), source: 'fixture', label: `${lead.label} arrives in the inbox`, work: lead });
  }

  // Records checks each record. Two are excluded with reasons — the office should show
  // work legitimately leaving the line, not only the happy path.
  for (const lead of LEADS) {
    push({ type: 'handoff', occurredAt: step(320), source: 'fixture', label: 'To Records', work: lead, from: 'inbox', to: 'records', direction: 'forward' });
  }
  push({ type: 'assignment.started', occurredAt: step(), source: 'fixture', label: 'Checking records for duplicates and exclusions', station: 'records' });
  push({ type: 'assignment.finished', occurredAt: step(1400), source: 'fixture', label: 'Records checked', station: 'records' });

  const excluded = LEADS.slice(4);
  for (const lead of excluded) {
    push({ type: 'blocked', occurredAt: step(200), source: 'fixture', label: `${lead.label} held`, station: 'records', work: lead, waitingOn: 'contact preferences to be confirmed' });
  }

  const live = LEADS.slice(0, 4);

  // Context, then Research. A specialist is called in for the research assignment.
  for (const lead of live) {
    push({ type: 'handoff', occurredAt: step(260), source: 'fixture', label: 'To Context', work: lead, from: 'records', to: 'context', direction: 'forward' });
  }
  push({ type: 'assignment.started', occurredAt: step(), source: 'fixture', label: 'Reading the conversation history', station: 'context' });
  push({ type: 'assignment.finished', occurredAt: step(1500), source: 'fixture', label: 'History assembled', station: 'context' });

  push({
    type: 'specialist.joined',
    occurredAt: step(400),
    source: 'fixture',
    label: 'A specialist joins for a bounded assignment',
    detail: 'Check what changed at each business since last contact',
    worker: 'specialist-1',
    role: 'Researcher',
  });

  for (const lead of live) {
    push({ type: 'handoff', occurredAt: step(240), source: 'fixture', label: 'To Research', work: lead, from: 'context', to: 'research', direction: 'forward' });
  }
  push({ type: 'assignment.started', occurredAt: step(), source: 'fixture', label: 'Tracing evidence to the supplied records', station: 'research' });
  push({ type: 'artifact.created', occurredAt: step(1600), source: 'fixture', label: 'Source trail attached', station: 'research', artifact: { id: 'a1', name: 'Source trail', kind: 'evidence' } });
  push({ type: 'specialist.left', occurredAt: step(500), source: 'fixture', label: 'Assignment complete', worker: 'specialist-1' });

  // Opportunity, then Outreach.
  for (const lead of live) {
    push({ type: 'handoff', occurredAt: step(240), source: 'fixture', label: 'To Opportunity', work: lead, from: 'research', to: 'opportunity', direction: 'forward' });
  }
  push({ type: 'assignment.started', occurredAt: step(), source: 'fixture', label: 'Checking the follow-up window', station: 'opportunity' });
  push({ type: 'assignment.finished', occurredAt: step(1300), source: 'fixture', label: 'Two conversations worth reopening', station: 'opportunity' });

  const ready = live.slice(0, 2);
  for (const lead of ready) {
    push({ type: 'handoff', occurredAt: step(300), source: 'fixture', label: 'To Outreach', work: lead, from: 'opportunity', to: 'outreach', direction: 'forward' });
  }
  push({ type: 'assignment.started', occurredAt: step(), source: 'fixture', label: 'Preparing a draft from the documented history', station: 'outreach' });
  push({ type: 'artifact.created', occurredAt: step(1500), source: 'fixture', label: 'Draft prepared', station: 'outreach', artifact: { id: 'a2', name: 'Follow-up draft', kind: 'draft' } });

  // Review — and the flagship beat: one draft is sent back with a specific reason.
  for (const lead of ready) {
    push({ type: 'handoff', occurredAt: step(280), source: 'fixture', label: 'To Review', work: lead, from: 'outreach', to: 'review', direction: 'forward' });
  }
  push({ type: 'assignment.started', occurredAt: step(), source: 'fixture', label: 'Checking the draft against the source notes', station: 'review' });

  push({
    type: 'assignment.failed',
    occurredAt: step(1500),
    source: 'fixture',
    label: 'Revision required',
    station: 'review',
    work: ready[1],
    reason: 'The draft claims a second location opened; the notes do not say that',
  });
  push({
    type: 'handoff',
    occurredAt: step(300),
    source: 'fixture',
    label: 'Carried back to Outreach',
    work: ready[1],
    from: 'review',
    to: 'outreach',
    direction: 'backward',
    reason: 'The draft claims a second location opened; the notes do not say that',
  });
  push({ type: 'assignment.started', occurredAt: step(900), source: 'fixture', label: 'Reworking the draft without the unsupported claim', station: 'outreach' });
  push({ type: 'artifact.created', occurredAt: step(1600), source: 'fixture', label: 'Draft revised', station: 'outreach', artifact: { id: 'a3', name: 'Revised draft', kind: 'draft' } });
  push({ type: 'handoff', occurredAt: step(300), source: 'fixture', label: 'Back to Review', work: ready[1], from: 'outreach', to: 'review', direction: 'forward' });

  push({ type: 'review.requested', occurredAt: step(1200), source: 'fixture', label: 'Waiting on your decision', station: 'review', question: 'Approve these two drafts?' });

  for (const lead of ready) {
    push({ type: 'handoff', occurredAt: step(360), source: 'fixture', label: 'To the outbox', work: lead, from: 'review', to: 'outbox', direction: 'forward' });
  }

  push({ type: 'run.finished', occurredAt: step(800), source: 'fixture', label: 'The office has finished', outcome: 'completed' });

  return events;
}

/**
 * Six handoffs at one instant, to exercise the burst path.
 *
 * Explicitly synthetic. The point is invariant I5: these are genuinely simultaneous, so
 * they must animate concurrently in parallel lanes, and above the aggregation threshold
 * they collapse into a single cart with a count rather than becoming a swarm. What must
 * never happen is a queue — that would show a sequence that did not occur.
 */
export function demoBurst(): OfficeEvent[] {
  const emit = createEmitter('demo-burst');
  const events: OfficeEvent[] = [];
  const push = (input: Parameters<typeof emit>[0]) => events.push(emit(input));

  push({ type: 'run.started', occurredAt: 0, source: 'fixture', label: 'Burst test', plan: 'lead-reactivation' });
  for (const lead of LEADS) {
    push({ type: 'work.received', occurredAt: 0, source: 'fixture', label: `${lead.label} arrives`, work: lead });
  }
  // All six at the same millisecond. Not staggered, not sequential.
  for (const lead of LEADS) {
    push({ type: 'handoff', occurredAt: 1000, source: 'fixture', label: 'Simultaneous handoff', work: lead, from: 'inbox', to: 'records', direction: 'forward' });
  }
  for (const lead of LEADS) {
    push({ type: 'handoff', occurredAt: 2000, source: 'fixture', label: 'Simultaneous handoff', work: lead, from: 'records', to: 'review', direction: 'forward' });
  }
  push({ type: 'run.finished', occurredAt: 4000, source: 'fixture', label: 'Burst complete', outcome: 'completed' });

  return events;
}

/**
 * lead-workflow — the lead reactivation workflow itself, with no React in it.
 *
 * Extracted from the hook so the *event stream* can be tested directly. That matters
 * more here than usual: this module's output is what the office animates, so a bug in
 * what it reports is not a rendering glitch, it is the visualisation telling the viewer
 * something untrue. The honesty rules are only real if they are testable, and they are
 * only testable if the workflow can run without a browser.
 *
 * It also means a server could run this later without change (the bridge, a hosted
 * runner) — the hook is just one caller.
 *
 * Everything environmental is injected: emitting, persisting a lead, calling a model,
 * and waiting. Tests pass a collecting emitter and an instant wait.
 */

import {
  qualify,
  summarize,
  draftTemplate,
  type Lead,
  type Department,
} from './lead-engine.ts';
import { reviewDraft, groundedDraft } from './lead-review.ts';
import type { StationId } from './office-view/core/types.ts';
import type { ProducerEvent } from './office-view/core/events.ts';

/** Department name -> station id in the floor plan. */
export const STATION: Record<Department, StationId> = {
  Records: 'records',
  Context: 'context',
  Research: 'research',
  Opportunity: 'opportunity',
  Outreach: 'outreach',
  Review: 'review',
};

/** The order work flows through the office, used to classify a handoff's direction. */
const FLOW: Department[] = ['Records', 'Context', 'Research', 'Opportunity', 'Outreach', 'Review'];

/** What the workflow can ask a model to do. */
export type AgentTask = 'context' | 'draft' | 'review';

export type AgentOutput = {
  summary?: string;
  subject?: string;
  draft?: string;
  evidence?: { row: number; quote: string }[];
  approved?: boolean;
  review_note?: string;
};

export type AgentResult = {
  output: AgentOutput;
  usage: { input: number; output: number; estimatedCost: number | null; model: string };
};

/** Everything the workflow needs from its environment. */
export type WorkflowDeps = {
  /** Append one event. `source` and the envelope are the caller's business. */
  emit: (input: WorkflowEvent) => void;
  /** Persist a lead's changed fields. */
  updateLead: (id: string, patch: Partial<Lead>) => void;
  /**
   * Run one bounded model assignment. Absent means local-rules mode — and in that mode
   * the workflow must emit no specialists and no usage, because there are none.
   */
  callAgent?: (task: AgentTask, lead: Lead) => Promise<AgentResult>;
  /** Pace the work. Tests pass a no-op; the UI passes a real delay. */
  wait: (ms: number) => Promise<void>;
  /** Cancellation. */
  signal?: AbortSignal;
  /** Concurrent lead workers. Two by default, as the original build had. */
  concurrency?: number;
};

/**
 * The events this workflow can produce, minus the envelope fields its host fills in.
 *
 * Typed against the real contract rather than a loose record, so a mistake here fails
 * the build instead of quietly animating something untrue — a handoff missing its
 * `direction`, say, or a `blocked` event with no stated reason.
 */
export type WorkflowEvent = ProducerEvent;

export type WorkflowOptions = {
  leads: Lead[];
  offer: string;
  /** Evaluation date, YYYY-MM-DD. */
  date: string;
  recordCount: number;
};

const pace = { work: 700, agent: 200 } as const;

/**
 * Run the workflow, reporting everything it does.
 *
 * Returns when every lead has been processed or the signal aborts.
 */
export async function runLeadWorkflow(
  options: WorkflowOptions,
  deps: WorkflowDeps,
): Promise<{ status: 'completed' | 'stopped'; uniqueLeads: number }> {
  const { leads, offer, date, recordCount } = options;
  const { emit, updateLead, callAgent, wait, signal } = deps;
  const live = Boolean(callAgent);

  /** Where each lead currently sits, so a handoff can name where it came from. */
  const holder = new Map<string, StationId | 'inbox' | 'outbox'>();

  emit({ type: 'run.started', label: 'The office opens', plan: 'lead-reactivation' });
  emit({
    type: 'note',
    label: `${recordCount} records received`,
    detail:
      `${leads.length} unique leads. ${recordCount - leads.length} duplicate records merged by email. ` +
      (live
        ? 'AI specialists are enabled.'
        : 'Local rules and templates; no model calls, so no specialists and no usage.'),
  });

  for (const lead of leads) {
    holder.set(lead.id, 'inbox');
    emit({
      type: 'work.received',
      label: `${lead.company || lead.name} arrives in the inbox`,
      work: { id: lead.id, label: lead.company || lead.name },
    });
  }

  /** Move a lead, declaring where it came from and which way it went. */
  const handoff = (lead: Lead, to: StationId | 'outbox', label: string, reason?: string) => {
    const from = holder.get(lead.id) ?? 'inbox';
    // Nothing moved, so nothing is reported. This happens on the rework loop: the folder
    // was already carried back to Outreach, and the loop then asks to move it there
    // again. Emitting would animate a journey that did not take place (invariant I2).
    if (from === to) return;
    // Direction is declared, never inferred from geometry: the carried-back beat has its
    // own path and pacing, and every producer of this contract must be able to state it.
    const fromIndex = FLOW.findIndex((d) => STATION[d] === from);
    const toIndex = FLOW.findIndex((d) => STATION[d] === to);
    const direction: 'forward' | 'backward' =
      fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex ? 'backward' : 'forward';
    emit({
      type: 'handoff',
      label,
      work: { id: lead.id, label: lead.company || lead.name },
      from,
      to,
      direction,
      ...(reason ? { reason } : {}),
    });
    holder.set(lead.id, to);
  };

  const move = async (lead: Lead, to: Department, label: string) => {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    handoff(lead, STATION[to], `Carrying ${lead.company || lead.name} to ${to}`);
    emit({
      type: 'assignment.started',
      label,
      station: STATION[to],
      work: { id: lead.id, label: lead.company || lead.name },
    });
    // Pacing of the actual work. Never scaled by playback speed — the office can be
    // replayed faster, but the work takes as long as it takes.
    await wait(live ? pace.agent : pace.work);
  };

  const finish = (lead: Lead, at: Department, label: string, detail?: string) =>
    emit({
      type: 'assignment.finished',
      label,
      ...(detail ? { detail } : {}),
      station: STATION[at],
      work: { id: lead.id, label: lead.company || lead.name },
    });

  /** One bounded model assignment, reported as a specialist joining and leaving. */
  const assign = async (task: AgentTask, lead: Lead): Promise<AgentOutput> => {
    if (!callAgent) throw new Error('No agent is configured.');
    const role = task === 'context' ? 'Context' : task === 'draft' ? 'Outreach' : 'Review';
    const workerId = `${task}-${lead.id}`;

    emit({
      type: 'specialist.joined',
      label: 'A specialist joins for a bounded assignment',
      detail: `${role}: ${lead.company || lead.name}`,
      worker: workerId,
      role,
    });

    try {
      const result = await callAgent(task, lead);
      // Usage always states where the number came from.
      emit({
        type: 'usage.reported',
        label: 'Usage reported by the provider',
        usage: {
          source: 'provider-response',
          worker: workerId,
          model: result.usage.model,
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
          /*
           * Omitted entirely when unknown, never sent as null. The contract says
           * `estimatedCostUsd?: number`, so absence IS how "we do not know this
           * model's price" is represented. A null would fail validation; a zero would lie.
           */
          ...(result.usage.estimatedCost === null
            ? {}
            : { estimatedCostUsd: result.usage.estimatedCost }),
        },
      });
      return result.output;
    } finally {
      emit({ type: 'specialist.left', label: 'Assignment complete', worker: workerId });
    }
  };

  const processLead = async (original: Lead) => {
    const l = { ...original };
    try {
      await move(l, 'Records', 'Checking the record');
      Object.assign(l, qualify(l, date));
      finish(
        l,
        'Records',
        'Record checked',
        l.sources.length > 1
          ? `${l.sources.length} source rows joined; all contact preferences preserved.`
          : 'Email, dates, and contact preferences checked.',
      );

      if (l.state === 'excluded') {
        l.processed = true;
        updateLead(l.id, l);
        emit({
          type: 'blocked',
          label: 'Removed from outreach',
          station: 'records',
          work: { id: l.id, label: l.company || l.name },
          waitingOn: l.reason,
        });
        return;
      }

      await move(l, 'Context', 'Reading the conversation history');
      l.summary = summarize(l) || 'No history was supplied.';
      if (live && l.state === 'ready') {
        const result = await assign('context', l);
        l.summary = result.summary || l.summary;
        l.evidence = (result.evidence || []).map((e) => `Row ${e.row}: ${e.quote}`);
      }
      updateLead(l.id, { summary: l.summary });
      finish(
        l,
        'Context',
        'History assembled',
        `${l.sources.length} source record${l.sources.length > 1 ? 's' : ''} attached.`,
      );

      await move(l, 'Research', 'Checking the source trail');
      if (!l.evidence.length) {
        l.evidence = l.sources.filter((s) => s.notes).map((s) => `Row ${s.row}: ${s.notes}`);
      }
      emit({
        type: 'artifact.created',
        label: 'Source trail attached',
        detail: `${l.evidence.length} references to supplied notes. No external web research was performed.`,
        station: 'research',
        work: { id: l.id, label: l.company || l.name },
        artifact: { id: `evidence-${l.id}`, name: 'Source trail', kind: 'evidence' },
      });

      await move(l, 'Opportunity', 'Checking the follow-up window');
      if (l.state !== 'ready') {
        emit({
          type: 'blocked',
          label: 'Follow-up held',
          station: 'opportunity',
          work: { id: l.id, label: l.company || l.name },
          waitingOn: l.reason,
        });
        l.processed = true;
        updateLead(l.id, l);
        return;
      }
      finish(l, 'Opportunity', 'A conversation worth reviewing', l.reason);

      // --- Draft, review, and (at most once) rework -------------------------------
      // Real machinery. It fires only when a review genuinely fails, and the redraft
      // genuinely fixes what the reviewer objected to. Never staged for the animation.
      let reworked = false;

      for (;;) {
        await move(l, 'Outreach', live ? 'Assigning a draft specialist' : 'Preparing a draft');
        if (live) {
          const result = await assign('draft', l);
          l.subject = result.subject || '';
          l.draft = result.draft || '';
          l.evidence = (result.evidence || []).map((e) => `Row ${e.row}: ${e.quote}`);
        } else if (reworked) {
          // The reviewer's objection was that the draft referenced nothing the contact
          // said. Grounding it in a quoted source note is a real fix, not a reshuffle.
          Object.assign(l, groundedDraft(l, offer));
        } else {
          Object.assign(l, draftTemplate(l, offer));
        }
        updateLead(l.id, { subject: l.subject, draft: l.draft, evidence: l.evidence });
        emit({
          type: 'artifact.created',
          label: reworked ? 'Draft revised' : 'Draft prepared',
          detail: live
            ? 'Personalised from supplied records and your offer.'
            : reworked
              ? 'Rewritten around a quote from the supplied notes.'
              : 'A local template is ready.',
          station: 'outreach',
          work: { id: l.id, label: l.company || l.name },
          artifact: {
            id: `draft-${l.id}-${reworked ? 2 : 1}`,
            name: 'Follow-up draft',
            kind: 'draft',
          },
        });

        await move(
          l,
          'Review',
          live ? 'Assigning an independent reviewer' : 'Checking the draft against the notes',
        );

        const outcome = live
          ? await (async () => {
              const result = await assign('review', l);
              return {
                approved: result.approved !== false,
                reason: result.review_note || 'Review completed.',
              };
            })()
          : reviewDraft(l, l.draft, offer);

        if (outcome.approved) {
          finish(l, 'Review', 'Handed to you for review', outcome.reason);
          break;
        }

        emit({
          type: 'assignment.failed',
          label: 'Revision required',
          station: 'review',
          work: { id: l.id, label: l.company || l.name },
          reason: outcome.reason,
        });

        if (reworked) {
          // One retry only, and the office says so rather than looping out of sight.
          l.state = 'hold';
          l.review = 'held';
          l.reason = outcome.reason;
          emit({
            type: 'blocked',
            label: 'Held after one revision',
            station: 'review',
            work: { id: l.id, label: l.company || l.name },
            waitingOn: 'your decision — the rework did not satisfy the reviewer',
          });
          break;
        }

        reworked = true;
        handoff(l, 'outreach', `Carrying ${l.company || l.name} back to Outreach`, outcome.reason);
      }

      if (l.state === 'ready') handoff(l, 'outbox', 'Finished work leaves the building');

      l.processed = true;
      updateLead(l.id, l);
    } catch (err) {
      if (signal?.aborted) return;
      const message = err instanceof Error ? err.message : 'The assignment failed.';
      updateLead(l.id, {
        state: 'hold',
        reason: 'AI assignment failed — review required',
        aiError: message,
        processed: true,
        review: 'held',
      });
      emit({
        type: 'assignment.failed',
        label: 'Assignment needs attention',
        station: 'review',
        work: { id: l.id, label: l.company || l.name },
        reason: message,
      });
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < leads.length && !signal?.aborted) {
      await processLead(leads[cursor++]);
    }
  };

  await Promise.all(Array.from({ length: deps.concurrency ?? 2 }, worker));

  const stopped = Boolean(signal?.aborted);
  emit({
    type: 'run.finished',
    label: stopped ? 'Run stopped' : 'The office has finished',
    detail: stopped
      ? 'Completed artifacts remain available. Rerun to start a fresh pass.'
      : 'Review your leads and export the packet. No messages were sent.',
    outcome: stopped ? 'stopped' : 'completed',
  });

  return { status: stopped ? 'stopped' : 'completed', uniqueLeads: leads.length };
}

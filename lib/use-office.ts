'use client';
/**
 * use-office — the lead reactivation workflow, as a producer of OfficeEvent.
 *
 * This hook does the actual work (via `lead-engine`) and reports it as the same event
 * contract the Claude Code bridge will emit. The renderer consumes only that contract,
 * so it has no idea what a "lead" is — which is the whole point of the seam.
 *
 * Three rules govern what gets emitted, and they are not negotiable:
 *
 *  - **Only report what happened.** Local-rules mode emits no `specialist.joined` and no
 *    `usage.reported`, because no specialist was called in and nothing was spent.
 *    Animating either would be a lie.
 *  - **Handoffs state their direction.** A reviewer sending work back is a designed beat
 *    with its own path and pacing, so it is declared, never inferred from geometry.
 *  - **Playback speed is not workflow speed.** The office can be replayed at 3x; the
 *    work itself always takes as long as it takes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  SAMPLE_CSV,
  SAMPLE_DATE,
  DEFAULT_OFFER,
  parseCSV,
  deduplicate,
  type Lead,
} from './lead-engine.ts';
import { runLeadWorkflow, type AgentResult, type AgentTask } from './lead-workflow.ts';
import type { OfficeEvent, StationId } from './office-view/core/types.ts';
import { createEmitter } from './office-view/core/events.ts';

/**
 * A display row for the activity trail and inspection panels.
 *
 * A view model derived from the canonical event stream, so the UI never has to know the
 * contract's shape and the contract never has to carry presentation concerns.
 */
export type ActivityItem = {
  id: string;
  at: number;
  station?: StationId;
  /**
   * The two ends of a handoff. A handoff happens *between* desks, so it has no single
   * station — without these it belongs to no department and silently vanishes from every
   * per-department view, which is exactly where work arriving and leaving matters most.
   */
  from?: string;
  to?: string;
  leadId?: string;
  title: string;
  detail?: string;
  tone: 'started' | 'completed' | 'warning';
  tokens?: number;
};

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Stopped', 'AbortError'));
      return;
    }
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });

/**
 * What a producer supplies for one event.
 *
 * `source` and `occurredAt` are filled in centrally — every event from this hook comes
 * from the same producer at the moment it is emitted, so making call sites repeat them
 * would just be an opportunity to get one wrong. Distributive so each union member keeps
 * its own fields (a plain `Omit` over a union collapses to the common keys).
 */
type Emitted = Parameters<ReturnType<typeof createEmitter>>[0];
/** Distributes over the union: `T` here is a naked type parameter, which an alias is not. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EmitInput = DistributiveOmit<Emitted, 'source' | 'occurredAt'>;

/**
 * Call the server proxy for one bounded model assignment.
 *
 * The key never leaves the browser except over the site's own HTTPS connection to its
 * own server, which forwards it to the provider. It is not persisted or logged here.
 */
async function callAgentViaProxy(
  task: AgentTask,
  lead: Lead,
  offer: string,
  date: string,
  key: string,
  signal: AbortSignal,
): Promise<AgentResult> {
  const response = await fetch('/api/agent', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-o6-api-key': key },
    body: JSON.stringify({ task, lead, offer, date }),
  });
  const body = (await response.json()) as {
    error?: string;
    output: AgentResult['output'];
    // null when the proxy could not price the model. Kept null all the way to the meter.
    usage: { input: number; output: number; estimatedCost: number | null };
    // The proxy reports which provider and model actually ran. The client does not
    // assume — guessing would put a wrong model name on the office's own meter.
    model?: string;
    provider?: string;
  };
  // Fail loudly: swallowing this would show the office completing work it never did.
  if (!response.ok) throw new Error(body.error || 'The assignment failed.');
  return { output: body.output, usage: { ...body.usage, model: body.model ?? 'unknown model' } };
}

/**
 * Project an event stream into display rows.
 *
 * Pure and exported so the same projection can be applied to a *recorded* run — the
 * inspection panels must describe whatever the floor is currently showing, not a
 * different stream. A panel saying "no assignments yet" while the office visibly works
 * would be the product contradicting itself.
 */
export function toActivity(events: readonly OfficeEvent[]): ActivityItem[] {
  return events.map((event) => {
    const tone: ActivityItem['tone'] =
      event.type === 'assignment.failed' || event.type === 'blocked'
        ? 'warning'
        : event.type === 'assignment.started'
          ? 'started'
          : 'completed';
    return {
      id: event.id,
      at: event.occurredAt,
      station: 'station' in event ? (event.station as StationId) : undefined,
      from: 'from' in event ? (event.from as string) : undefined,
      to: 'to' in event ? (event.to as string) : undefined,
      leadId: 'work' in event ? event.work?.id : undefined,
      title: event.label,
      detail: event.detail,
      tone,
      tokens:
        event.type === 'usage.reported'
          ? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)
          : undefined,
    };
  });
}

export function useOffice() {
  const [rows, setRows] = useState(() => parseCSV(SAMPLE_CSV));
  const [leads, setLeads] = useState<Lead[]>(() => deduplicate(parseCSV(SAMPLE_CSV)));
  const [sample, setSample] = useState(true);
  const [sourceName, setSourceName] = useState('Fictional sample');
  const [events, setEvents] = useState<OfficeEvent[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'completed' | 'stopped'>('idle');
  const [error, setError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [offer, setOffer] = useState(DEFAULT_OFFER);
  const [runMode, setRunMode] = useState('Sample · local rules');
  const [elapsed, setElapsed] = useState(0);
  /** Playback speed for the office. Never affects how fast the work itself runs. */
  const [speed, setSpeed] = useState(1);

  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const clock = useRef(0);
  const emitter = useRef(createEmitter('run-0'));

  const running = phase === 'running';
  const date = sample ? SAMPLE_DATE : new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - clock.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => () => controller.current?.abort(), []);

  const updateLead = useCallback(
    (id: string, patch: Partial<Lead>) =>
      setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l))),
    [],
  );

  /** Append one event to the canonical stream. */
  const emit = useCallback((input: EmitInput) => {
    // The assertion is needed because spreading a discriminated union widens it; the
    // shape is guaranteed by EmitInput, and isOfficeEvent covers it at runtime in tests.
    const event = emitter.current({
      ...input,
      source: 'lead-workflow',
      occurredAt: Date.now(),
    } as Emitted);
    setEvents((prev) => [...prev, event]);
    return event;
  }, []);

  /**
   * Who is doing what, right now — derived from the event stream rather than stored.
   *
   * Previously this was a separate `active` map maintained alongside the log, which is
   * two sources of truth for one fact. The stream is the truth.
   */
  const active = useMemo(() => {
    const current: Record<string, StationId> = {};
    for (const event of events) {
      if (event.type === 'assignment.started' && event.work) current[event.work.id] = event.station;
      else if (event.type === 'assignment.finished' && event.work) delete current[event.work.id];
      else if (event.type === 'assignment.failed' && event.work) delete current[event.work.id];
    }
    return current;
  }, [events]);

  /**
   * Reported usage, derived from the stream rather than counted alongside it.
   *
   * Only successful, completed assignments report usage, so this is what the
   * provider actually told us — never an estimate of what a failed or aborted call might
   * have cost. In local-rules mode there are no such events and this stays at zero,
   * which is the truth rather than a placeholder.
   */
  const usage = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let calls = 0;
    // One call we cannot price makes the whole total unknowable. Reporting the rest as
    // if it were the bill would understate it, and understating a cost is the dangerous
    // direction to be wrong in.
    let unpriced = 0;

    for (const event of events) {
      if (event.type !== 'usage.reported') continue;
      tokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
      if (event.usage.estimatedCostUsd === undefined) unpriced += 1;
      else cost += event.usage.estimatedCostUsd;
      calls += 1;
    }

    return {
      tokens,
      calls,
      unpriced,
      /** null means "we cannot say", which is not the same as zero. */
      cost: unpriced > 0 ? null : cost,
    };
  }, [events]);

  /** The activity trail, derived from the canonical stream. */
  const activity = useMemo(() => toActivity(events), [events]);

  /**
   * Record the human's decision on a draft.
   *
   * This belongs in the stream like any other event: a person approving or holding a
   * draft is part of what happened, and the exported packet should show it. Nothing is
   * ever sent as a result — approval marks a record, it does not dispatch a message.
   */
  const recordDecision = useCallback(
    (lead: Lead, decision: Lead['review']) => {
      // 'pending' is the absence of a decision, so there is nothing to record.
      if (decision === 'pending') return;
      emit({
        type: 'review.resolved',
        label: decision === 'approved' ? 'Draft reviewed by you' : 'Draft held by you',
        detail: 'Human decision recorded. Nothing was sent.',
        station: 'review',
        work: { id: lead.id, label: lead.company || lead.name },
        decision: decision === 'approved' ? 'approved' : 'denied',
      });
    },
    [emit],
  );

  function resetRun() {
    setEvents([]);
    setElapsed(0);
    setError('');
  }

  function importCSV(text: string, name: string) {
    if (busy.current) throw new Error('Stop the current run before importing.');
    const data = parseCSV(text);
    setRows(data);
    setLeads(deduplicate(data));
    setSample(false);
    setSourceName(name);
    setOffer('');
    setPhase('idle');
    resetRun();
  }

  function resetSample() {
    if (busy.current) return;
    setRows(parseCSV(SAMPLE_CSV));
    setLeads(deduplicate(parseCSV(SAMPLE_CSV)));
    setSample(true);
    setOffer(DEFAULT_OFFER);
    setSourceName('Fictional sample');
    setPhase('idle');
    setRunMode('Sample · local rules');
    resetRun();
  }

  async function run(forceSample = false) {
    if (busy.current) throw new Error('A run is already in progress.');

    const input = forceSample ? parseCSV(SAMPLE_CSV) : rows;
    const isSample = forceSample || sample;
    const key = forceSample ? '' : apiKey.trim();
    const runOffer = forceSample ? DEFAULT_OFFER : offer.trim();

    if (!runOffer) {
      setError('Add a short description of your offer in run settings.');
      return { error: 'Offer required' };
    }
    // Either provider's key shape. Which one runs is inferred from the key itself, so
    // there is nothing extra to configure and nothing to get wrong.
    const isAnthropic = key.startsWith('sk-ant-');
    if (key && !(isAnthropic ? /^sk-ant-[\w-]{20,}$/ : /^sk-[\w-]{10,}$/).test(key)) {
      setError('Check the API key in run settings. OpenAI and Anthropic keys are both accepted.');
      return { error: 'Invalid key' };
    }

    busy.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const signal = abort.signal;

    if (forceSample) {
      setRows(input);
      setSample(true);
      setSourceName('Fictional sample');
      setOffer(DEFAULT_OFFER);
    }

    const batch = deduplicate(input);
    const runDate = isSample ? SAMPLE_DATE : new Date().toISOString().slice(0, 10);
    emitter.current = createEmitter(`run-${Date.now()}`);

    setLeads(batch);
    resetRun();
    clock.current = Date.now();
    setPhase('running');
    setRunMode(
      key
        ? `Live AI · ${isAnthropic ? 'Anthropic' : 'OpenAI'}`
        : isSample
          ? 'Sample · local rules'
          : 'Your data · local rules',
    );

    // The workflow itself lives in lead-workflow.ts, with no React in it, so its event
    // stream can be tested directly. This hook only binds it to React state.
    let result: { status: 'completed' | 'stopped'; uniqueLeads: number } = {
      status: 'stopped',
      uniqueLeads: batch.length,
    };
    try {
      result = await runLeadWorkflow(
        { leads: batch, offer: runOffer, date: runDate, recordCount: input.length },
        {
          emit,
          updateLead,
          wait: (ms) => wait(ms, signal),
          signal,
          callAgent: key
            ? (task, lead) => callAgentViaProxy(task, lead, runOffer, runDate, key, signal)
            : undefined,
        },
      );
      setPhase(signal.aborted ? 'stopped' : 'completed');
    } finally {
      busy.current = false;
      setElapsed(Math.floor((Date.now() - clock.current) / 1000));
      controller.current = null;
    }

    return result;
  }

  return {
    rows,
    leads,
    sample,
    sourceName,
    /** The canonical stream. This is what the office renders. */
    events,
    /** Display rows derived from the stream, for trails and panels. */
    activity,
    active,
    phase,
    error,
    setError,
    apiKey,
    setApiKey,
    offer,
    setOffer,
    runMode,
    elapsed,
    speed,
    usage,
    running,
    date,
    run,
    importCSV,
    resetSample,
    updateLead,
    recordDecision,
    stop: () => controller.current?.abort(),
    /** Playback only. The workflow's own pacing is unaffected. */
    toggleSpeed: () => setSpeed((current) => (current === 1 ? 3 : 1)),
  };
}

/**
 * office-view/core/events — runtime validation and ordering for the event contract.
 *
 * Why this is strict rather than a cast: the local bridge (T005) accepts POSTs from
 * Claude Code hooks, and a fixture can be any JSON file a visitor loads. Both are
 * untrusted input crossing into the renderer. A `as OfficeEvent` here would push a
 * malformed payload straight into the animation scheduler, where the failure mode is a
 * silently wrong picture rather than a loud error — which is the worst outcome for a
 * product whose entire claim is that what you see is what happened.
 *
 * Boundary rule: this file imports nothing but its own types.
 */

import type { OfficeEvent, OfficeEventType, UsageReport } from './types.ts';
import { OFFICE_EVENT_TYPES, OFFICE_EVENT_VERSION } from './types.ts';

/** Narrow an unknown to a plain object we can index without upsetting TypeScript. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Finite numbers only. `NaN` and `Infinity` would poison the animation clock. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

/** A `WorkRef` — the folder a visitor sees moving around the floor. */
function isWorkRef(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.label);
}

const USAGE_SOURCES = new Set<UsageReport['source']>([
  'transcript',
  'provider-response',
  'unavailable',
]);

function isUsageReport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!USAGE_SOURCES.has(value.source as UsageReport['source'])) return false;
  return (
    isOptional(value.worker, isNonEmptyString) &&
    isOptional(value.model, isNonEmptyString) &&
    isOptional(value.inputTokens, isFiniteNumber) &&
    isOptional(value.cachedInputTokens, isFiniteNumber) &&
    isOptional(value.outputTokens, isFiniteNumber) &&
    isOptional(value.estimatedCostUsd, isFiniteNumber)
  );
}

const EVENT_TYPES = new Set<string>(OFFICE_EVENT_TYPES);

/**
 * Per-variant required fields. Kept as a table rather than a switch so that adding an
 * event type is a one-line change in two places (here and the union) instead of an
 * easily-forgotten branch.
 */
const VARIANT_CHECKS: Record<OfficeEventType, (e: Record<string, unknown>) => boolean> = {
  'run.started': (e) => isNonEmptyString(e.plan),
  'run.finished': (e) =>
    e.outcome === 'completed' || e.outcome === 'stopped' || e.outcome === 'failed',
  'work.received': (e) => isWorkRef(e.work),
  'assignment.started': (e) =>
    isNonEmptyString(e.station) &&
    isOptional(e.worker, isNonEmptyString) &&
    isOptional(e.work, isWorkRef),
  'assignment.finished': (e) =>
    isNonEmptyString(e.station) &&
    isOptional(e.worker, isNonEmptyString) &&
    isOptional(e.work, isWorkRef),
  'assignment.failed': (e) =>
    isNonEmptyString(e.station) &&
    isNonEmptyString(e.reason) &&
    isOptional(e.worker, isNonEmptyString) &&
    isOptional(e.work, isWorkRef),
  handoff: (e) =>
    isWorkRef(e.work) &&
    isNonEmptyString(e.from) &&
    isNonEmptyString(e.to) &&
    // Explicit, never inferred — see the note in types.ts.
    (e.direction === 'forward' || e.direction === 'backward') &&
    isOptional(e.reason, isNonEmptyString),
  'specialist.joined': (e) =>
    isNonEmptyString(e.worker) &&
    isNonEmptyString(e.role) &&
    isOptional(e.station, isNonEmptyString),
  'specialist.left': (e) => isNonEmptyString(e.worker),
  'artifact.created': (e) =>
    isRecord(e.artifact) &&
    isNonEmptyString(e.artifact.id) &&
    isNonEmptyString(e.artifact.name) &&
    isNonEmptyString(e.artifact.kind) &&
    isNonEmptyString(e.station) &&
    isOptional(e.work, isWorkRef),
  'review.requested': (e) =>
    isNonEmptyString(e.station) &&
    isNonEmptyString(e.question) &&
    isOptional(e.work, isWorkRef),
  'review.resolved': (e) =>
    isNonEmptyString(e.station) &&
    (e.decision === 'approved' || e.decision === 'denied') &&
    isOptional(e.work, isWorkRef),
  blocked: (e) =>
    isNonEmptyString(e.station) &&
    isNonEmptyString(e.waitingOn) &&
    isOptional(e.work, isWorkRef),
  'usage.reported': (e) => isUsageReport(e.usage),
  note: () => true,
};

const SOURCES = new Set(['lead-workflow', 'claude-code', 'fixture']);

/**
 * Strict runtime validator. Returns a type predicate so callers get a typed event.
 *
 * Deliberately rejects unknown `type` values rather than passing them through: a
 * forward-compatible producer sending a type we do not render would otherwise appear
 * to have been handled. The bridge logs and skips unknown events explicitly instead.
 */
export function isOfficeEvent(value: unknown): value is OfficeEvent {
  if (!isRecord(value)) return false;

  if (value.v !== OFFICE_EVENT_VERSION) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isFiniteNumber(value.seq)) return false;
  if (!isNonEmptyString(value.runId)) return false;
  if (typeof value.source !== 'string' || !SOURCES.has(value.source)) return false;
  if (!isFiniteNumber(value.occurredAt)) return false;
  if (!isOptional(value.receivedAt, isFiniteNumber)) return false;
  // `label` is what the visitor actually reads. An unlabelled event would render as a
  // blank status, so it is required rather than defaulted.
  if (!isNonEmptyString(value.label)) return false;
  if (!isOptional(value.detail, isNonEmptyString)) return false;

  if (typeof value.type !== 'string' || !EVENT_TYPES.has(value.type)) return false;
  return VARIANT_CHECKS[value.type as OfficeEventType](value);
}

/** Validate a whole stream, e.g. a fixture file loaded from disk or over the network. */
export function isOfficeEventStream(value: unknown): value is OfficeEvent[] {
  return Array.isArray(value) && value.every(isOfficeEvent);
}

/**
 * Canonical ordering: by when it *happened*, then by producer sequence.
 *
 * This is invariant I5. Ordering by `occurredAt` first means genuinely simultaneous
 * events keep the same timestamp and are handed to the scheduler as a simultaneous
 * group, so it can put them in parallel lanes rather than inventing a sequence. `seq`
 * only breaks exact ties, and because it is producer-assigned rather than
 * arrival-assigned, a replay orders identically to the original live run.
 */
export function compareEvents(a: OfficeEvent, b: OfficeEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
  return a.seq - b.seq;
}

/**
 * Sort a stream into canonical order without mutating the caller's array.
 *
 * `Array.prototype.sort` is required to be stable in modern engines, so events sharing
 * both `occurredAt` and `seq` (which should not happen, but might from a sloppy
 * producer) keep insertion order rather than shuffling between runs.
 */
export function sortEvents(events: readonly OfficeEvent[]): OfficeEvent[] {
  return [...events].sort(compareEvents);
}

/**
 * Group a canonically-ordered stream into simultaneity buckets.
 *
 * The scheduler consumes these rather than a flat list: everything in one bucket
 * happened at the same instant and must be animated concurrently. This is the concrete
 * mechanism that stops a burst of parallel tool calls being rendered as a queue.
 */
export function groupSimultaneous(events: readonly OfficeEvent[]): OfficeEvent[][] {
  const groups: OfficeEvent[][] = [];
  for (const event of sortEvents(events)) {
    const last = groups[groups.length - 1];
    if (last && last[0].occurredAt === event.occurredAt) last.push(event);
    else groups.push([event]);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Deterministic helpers
//
// Determinism is a set of bans (PLAN.md A5): no Math.random, no Date.now inside the
// scene. Anything that needs to look "random" — a walker's lane, a stagger offset —
// derives from a stable id instead, so a replay is pixel-identical to the live run it
// came from.
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit. Chosen for being short, dependency-free and stable across engines —
 * we need the *same* number in Node (tests) and the browser (render), forever.
 */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // 32-bit FNV prime multiply, via shifts to stay in integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Stable per-event jitter in [0, maxMs). Five folders leaving at once in perfect
 * lockstep reads as a rendering glitch; a small stagger reads as life. Derived from the
 * event id rather than a sequential draw, so it survives replay and reordering.
 */
export function jitterFor(eventId: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  return hashId(eventId) % maxMs;
}

// ---------------------------------------------------------------------------
// Construction helper
// ---------------------------------------------------------------------------

/** Fields a producer supplies; the envelope bookkeeping is filled in for it. */
type EventInput = Omit<OfficeEvent, 'v' | 'seq' | 'id' | 'runId'> & { id?: string };

/**
 * Emitter factory. Producers use this instead of hand-building envelopes so that `seq`
 * is genuinely monotonic and ids are stable and unique within the run.
 *
 * Note the id derives from the run and sequence, not from a random source, so a
 * re-recorded run produces identical ids and therefore identical animation jitter.
 */
export function createEmitter(runId: string, startSeq = 0) {
  let seq = startSeq;
  return function emit(input: EventInput): OfficeEvent {
    seq += 1;
    const event = {
      ...input,
      v: OFFICE_EVENT_VERSION,
      id: input.id ?? `${runId}-${seq}`,
      seq,
      runId,
    } as OfficeEvent;
    return event;
  };
}

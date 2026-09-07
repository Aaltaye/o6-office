/**
 * office-view/core/attribution — who an event belongs to.
 *
 * Claude Code names a worker on an event only when the work happened inside a subagent:
 * the hook mapping writes `agent:<id>` when there is an `agent_id` and leaves the field
 * off otherwise. So a missing worker is not missing information — it is the main agent,
 * stated by omission.
 *
 * That rule was already implemented twice, independently, in different words: the
 * scheduler resolves `id ?? 'main'` when it materialises a figure on the floor, and the
 * transcript reader buckets usage under `usage.worker ?? 'main'`. The panel beside the
 * floor was the third place that needed it and was the one that did not have it, so
 * clicking the main agent produced a dossier reading zero assignments, zero desks — for
 * the agent that had done every single thing in the session. An empty dossier does not
 * read as "no attribution"; it reads as "this person did nothing", which is a claim, and
 * a false one.
 *
 * One function, so the three places cannot drift apart again, and so the rule is a thing
 * that can be tested rather than a coincidence repeated in three files.
 */

import type { OfficeEvent, WorkerId } from './types.ts';

/** The one worker that is never named on an event, because it is the default. */
export const MAIN_WORKER: WorkerId = 'main';

/**
 * Event types that describe somebody doing something, where an absent worker means the
 * main agent rather than nobody.
 *
 * Listed rather than inferred from the presence of the key: a JSON round-trip drops
 * `worker: undefined` entirely, so `'worker' in event` answers differently for a live
 * event and the same event replayed from a fixture. A list is the same in both.
 */
const ASSIGNMENT_TYPES: ReadonlySet<OfficeEvent['type']> = new Set([
  'assignment.started',
  'assignment.finished',
  'assignment.failed',
]);

/**
 * The worker an event belongs to, or null if the event is not about a worker at all.
 *
 * `run.started`, `artifact.created` and the rest return null — not `main`. An artifact
 * records the desk it was made at and genuinely does not record who made it, and
 * inventing an attribution for it would be exactly the guess this project refuses.
 */
export function workerOf(event: OfficeEvent): WorkerId | null {
  if (ASSIGNMENT_TYPES.has(event.type)) {
    return ('worker' in event ? event.worker : undefined) ?? MAIN_WORKER;
  }
  // specialist.joined / specialist.left always name their worker; nothing else has one.
  if ('worker' in event && typeof event.worker === 'string') return event.worker;
  return null;
}

/**
 * The worker a usage report is attributed to, or null when the report itself is unusable.
 *
 * A report whose source is `unavailable` carries no figure to attribute, so it is not
 * silently credited to the main agent — that would turn "we could not read the transcript"
 * into "the main agent spent nothing", which is the confident zero the whole usage path
 * exists to avoid.
 */
export function usageWorkerOf(event: OfficeEvent): WorkerId | null {
  if (event.type !== 'usage.reported') return null;
  if (event.usage.source === 'unavailable') return null;
  return event.usage.worker ?? MAIN_WORKER;
}

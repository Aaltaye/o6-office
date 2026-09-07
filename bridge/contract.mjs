/**
 * bridge/contract — tell a producer what is wrong with its event, in words.
 *
 * The office's real validator lives in `lib/office-view/core/events.ts`, but the bridge is
 * plain Node and cannot import a .ts module. So this mirrors it — and a test asserts the
 * two agree across every event in `fixtures/`, because a door that drifts from the room
 * behind it is worse than no door.
 *
 * The reason this exists at all: `/event` used to check only that `type` and `label` were
 * non-empty strings. Five of the shapes CONNECT.md documents passed that check, returned
 * `{ok:true, rejected:[]}`, and were then silently dropped by the renderer for missing a
 * required field. A producer got a success response and an empty floor, with nothing
 * anywhere to explain the gap. Refusing loudly is kinder than accepting quietly.
 */

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isWorkRef = (value) =>
  value !== null && typeof value === 'object' && isText(value.id) && isText(value.label);

/**
 * What each event type needs beyond `type` and `label`, and how to say so.
 *
 * Messages are written for whoever is holding the failing request — they name the field
 * and show the shape, because "invalid event" tells a producer nothing it can act on.
 */
const REQUIREMENTS = {
  'run.started': [[(e) => isText(e.plan), 'run.started needs "plan" — the floor to draw on, e.g. "coding-session"']],
  'run.finished': [
    [
      (e) => ['completed', 'stopped', 'failed'].includes(e.outcome),
      'run.finished needs "outcome": one of completed, stopped, failed',
    ],
  ],
  'work.received': [[(e) => isWorkRef(e.work), 'work.received needs work:{id,label} — the unit of work that arrived']],
  'assignment.started': [[(e) => isText(e.station), 'assignment.started happens at a desk: needs "station"']],
  'assignment.finished': [[(e) => isText(e.station), 'assignment.finished happens at a desk: needs "station"']],
  'assignment.failed': [
    [(e) => isText(e.station), 'assignment.failed happens at a desk: needs "station"'],
    [(e) => isText(e.reason), 'assignment.failed needs "reason" — what actually failed, literally'],
  ],
  handoff: [
    [(e) => isWorkRef(e.work), 'handoff needs work:{id,label} — the thing being handed over'],
    [(e) => isText(e.from) && isText(e.to), 'handoff needs "from" and "to"'],
    [
      (e) => e.direction === 'forward' || e.direction === 'backward',
      'handoff needs "direction": forward or backward. It is never inferred — work coming back is the point.',
    ],
  ],
  'specialist.joined': [
    [(e) => isText(e.worker), 'specialist.joined needs "worker" — a stable id, e.g. agent:planner'],
    [(e) => isText(e.role), 'specialist.joined needs "role" — what they were called in to do'],
  ],
  'specialist.left': [[(e) => isText(e.worker), 'specialist.left needs "worker" — the same id that joined']],
  'artifact.created': [
    [(e) => isText(e.station), 'artifact.created happens at a desk: needs "station"'],
    [
      (e) => e.artifact && isText(e.artifact.id) && isText(e.artifact.name) && isText(e.artifact.kind),
      'artifact.created needs artifact:{id,name,kind} — something a person could open',
    ],
  ],
  'review.requested': [
    [(e) => isText(e.station), 'review.requested happens at a desk: needs "station"'],
    [(e) => isText(e.question), 'review.requested needs "question" — what is being asked'],
  ],
  'review.resolved': [
    [(e) => isText(e.station), 'review.resolved happens at a desk: needs "station"'],
    [(e) => e.decision === 'approved' || e.decision === 'denied', 'review.resolved needs "decision": approved or denied'],
  ],
  blocked: [
    [(e) => isText(e.station), 'blocked happens at a desk: needs "station"'],
    [(e) => isText(e.waitingOn), 'blocked needs "waitingOn" — what it is waiting for'],
  ],
  'usage.reported': [
    [
      (e) => e.usage && ['transcript', 'provider-response', 'unavailable'].includes(e.usage.source),
      'usage.reported needs usage.source: transcript, provider-response, or unavailable. ' +
        'Never invent a number — "unavailable" is a real answer.',
    ],
  ],
  note: [],
};

export const KNOWN_TYPES = Object.keys(REQUIREMENTS);

/**
 * Everything wrong with this event, as sentences. Empty means the office will draw it.
 *
 * @param {object} event
 * @param {{stations?: string[]}} floor the desks this office actually has
 */
export function describeProblems(event, { stations } = {}) {
  const problems = [];
  if (!event || typeof event !== 'object') return ['not an object'];

  if (!isText(event.type)) problems.push('missing "type"');
  else if (!KNOWN_TYPES.includes(event.type)) {
    problems.push(`unknown type "${event.type}". Known types: ${KNOWN_TYPES.join(', ')}`);
  }

  if (!isText(event.label)) {
    problems.push(
      'missing "label" — every event must say what happened. It is the line a person ' +
        'reads on the desk, so state the literal action, not an intention.',
    );
  }

  for (const [check, why] of REQUIREMENTS[event.type] ?? []) {
    if (!check(event)) problems.push(why);
  }

  // A station that does not exist on this floor renders nowhere at all, silently.
  if (stations && isText(event.station) && !stations.includes(event.station)) {
    problems.push(`unknown station "${event.station}" — this floor has: ${stations.join(', ')}`);
  }

  return problems;
}

/** A machine-readable description of the door, so an agent can correct itself. */
export function contractSummary({ stations } = {}) {
  return {
    version: 1,
    stations: stations ?? [],
    events: Object.fromEntries(
      Object.entries(REQUIREMENTS).map(([type, rules]) => [
        type,
        { requires: rules.map(([, why]) => why) },
      ]),
    ),
    rules: [
      'Labels are literal. State what happened, never what an agent was thinking.',
      'Only report things that actually happened. Do not pre-announce work.',
      'Simultaneous work stays simultaneous — send the same occurredAt, do not serialise.',
      'Never invent token counts. "unavailable" is a real answer; zero is not.',
    ],
  };
}

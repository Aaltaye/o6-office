/**
 * bridge/emit — report one event from anything that can run a shell command.
 *
 * Claude Code gets a zero-code path because it has hooks. Every other runtime — Codex,
 * Replit, a loop somebody wrote this afternoon — does not, and telling those authors to
 * "just POST the contract" means writing an HTTP client, handling the token, and getting
 * the envelope right before they see a single desk light up. That is a lot to ask before
 * any payoff.
 *
 * So: one command, one event.
 *
 *   o6-office emit assignment.started "Reading the spec" --desk reading
 *
 * If your agent can run `bash`, it can drive the office. That is the whole idea.
 */

/** The desks a coding session has, so the error message can list them. */
export const DESKS = ['frontdesk', 'reading', 'research', 'operations', 'workshop', 'approvals'];

/**
 * Event types worth emitting by hand. The contract has more, but these are the ones a
 * producer actually reaches for; the rest are derived or come from the transcript.
 */
export const EMITTABLE = [
  'run.started',
  'run.finished',
  'work.received',
  'assignment.started',
  'assignment.finished',
  'assignment.failed',
  'artifact.created',
  'specialist.joined',
  'specialist.left',
  'note',
];

/**
 * Build the event body from CLI arguments.
 *
 * Deliberately strict about `label`: it is what a person reads on the desk, and an event
 * without one renders as a blank status. Better to refuse than to draw a silent box.
 */
export function buildEvent({ type, label, desk, worker, detail, work }) {
  if (!type || !EMITTABLE.includes(type)) {
    throw new Error(
      `Unknown event type ${JSON.stringify(type ?? '')}.\nTry one of: ${EMITTABLE.join(', ')}`,
    );
  }
  if (!label || !String(label).trim()) {
    throw new Error(
      'Every event needs a label — it is the line a person reads on the desk.\n' +
        'Say what actually happened, literally: "Reading src/app.ts", not "thinking".',
    );
  }

  const needsDesk = type.startsWith('assignment.') || type === 'artifact.created';
  if (needsDesk && !desk) {
    throw new Error(`${type} happens AT a desk. Pass --desk <${DESKS.join('|')}>.`);
  }

  const event = { type, label: String(label) };
  if (desk) event.station = desk;
  if (worker) event.worker = worker;
  if (detail) event.detail = String(detail);
  if (work) event.work = { id: String(work), label: String(work) };
  return event;
}

/**
 * Send one event to a running bridge.
 *
 * Never throws on a network failure: a visualisation being down must not break the work it
 * is visualising, which is the same reason the Claude Code hooks end in `|| true`.
 */
export async function sendEvent({ event, url, token, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${url}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': token },
      body: JSON.stringify(event),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && body.ok !== false, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: error.message }, offline: true };
  }
}

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

import { describeProblems, KNOWN_TYPES } from './contract.mjs';

/** The desks a coding session has, so the error message can list them. */
export const DESKS = ['frontdesk', 'reading', 'research', 'operations', 'workshop', 'approvals'];

/**
 * Event types worth emitting by hand.
 *
 * A subset of the contract: handoff, review.* and blocked belong to a workflow that knows
 * about units of work moving, and usage.reported is read from a transcript rather than
 * asserted — a producer inventing token counts is exactly what the office must not show.
 */
export const EMITTABLE = KNOWN_TYPES.filter(
  (type) => !['handoff', 'review.requested', 'review.resolved', 'blocked', 'usage.reported'].includes(type),
);

/**
 * Build the event body from CLI arguments.
 *
 * Deliberately strict about `label`: it is what a person reads on the desk, and an event
 * without one renders as a blank status. Better to refuse than to draw a silent box.
 */
export function buildEvent({
  type,
  label,
  desk,
  worker,
  detail,
  work,
  reason,
  role,
  outcome,
  artifact,
}) {
  if (!type || !EMITTABLE.includes(type)) {
    throw new Error(
      `Unknown event type ${JSON.stringify(type ?? '')}.\nTry one of: ${EMITTABLE.join(', ')}`,
    );
  }

  const event = { type, label: label === undefined ? undefined : String(label) };
  if (desk) event.station = desk;
  if (worker) event.worker = worker;
  if (detail) event.detail = String(detail);
  if (work) event.work = { id: String(work), label: String(work) };
  if (reason) event.reason = String(reason);
  if (role) event.role = String(role);
  if (outcome) event.outcome = String(outcome);
  // An artifact is something a person could open, so it needs a name and a kind.
  if (artifact) {
    event.artifact = { id: String(artifact), name: String(artifact), kind: 'file' };
  }
  // run.started's plan is supplied by the bridge, which knows which floor it draws.
  if (type === 'run.started') event.plan = 'coding-session';

  /*
   * Judged by the same rules the door uses, so the CLI can never accept something the
   * office would silently drop. Two validators drift; one does not.
   */
  const problems = describeProblems(event, { stations: DESKS });
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
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

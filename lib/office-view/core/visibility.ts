/**
 * office-view/core/visibility — who is drawn, and how.
 *
 * Three separate questions, and both renderers were answering all three inline with
 * slightly different expressions, in three places between them: the three.js floor, the SVG
 * floor's per-frame path, and the SVG's accessibility outline. That is the shape this
 * codebase has been bitten by repeatedly — a rule written out more than once is a rule that
 * will be subtly different in one of them, and the outline is the copy nobody looks at.
 *
 * It also lives here because the renderers are `.tsx`, which the test runner cannot import
 * under `--experimental-strip-types`. Logic that only exists in a component is logic that
 * can only be checked by looking at it.
 *
 * The three questions:
 *
 *   shown   — is this person on the floor at all?
 *   dormant — are they drawn as a record rather than as a colleague?
 *   working — do they have a literal action running right now?
 *
 * They are deliberately not collapsed into one. "Present" and "working" are different
 * facts, and conflating them is what previously had finished agents rendered as though they
 * were still running their last tool.
 */

import type { WorkerState } from './scheduler.ts';
import type { WorkerId } from './types.ts';

export type Presence = {
  /** Draw them at all. */
  shown: boolean;
  /**
   * Draw them as a record: no identity colour, no contact shadow.
   *
   * True only for somebody who has finished and stayed. A contact shadow is the claim that
   * someone is standing there, which is why removing it is the load-bearing part of the
   * treatment rather than a stylistic one.
   */
  dormant: boolean;
  /** They have a literal action running at this instant. */
  working: boolean;
};

export type PresenceOptions = {
  /**
   * Show only people with something running.
   *
   * A view filter. It can hide somebody who is present but between tool calls, and it can
   * hide a finished agent's record — it can never hide work that is actually happening,
   * which is the property the test pins.
   */
  activeOnly?: boolean;
  /** Finished agents the viewer has cleared off the floor. */
  dismissed?: ReadonlySet<WorkerId>;
};

const NOBODY: ReadonlySet<WorkerId> = new Set();

/**
 * Whether to draw this worker at time `t`, and how.
 *
 * Note the order the cases are decided in. Working beats everything: an agent that was
 * announced as departed and then worked again is a colleague, not a record, because the
 * most recent thing the stream said is that they are doing something. Getting that
 * backwards drew a grey shadowless marker at a desk that was simultaneously lit violet with
 * the tool that agent was running right then.
 */
export function presenceAt(
  worker: WorkerState,
  t: number,
  { activeOnly = false, dismissed = NOBODY }: PresenceOptions = {},
): Presence {
  const present = worker.present.sampleAt(t) ?? false;
  const working = worker.status.sampleAt(t) != null;

  // A cleared record is not on the floor, however it got there.
  const record = dismissed.has(worker.id) ? null : (worker.departed.sampleAt(t) ?? null);

  if (activeOnly) {
    // Only what is happening. Never anything else, and never less than that.
    return { shown: present && working, dormant: false, working };
  }

  const shown = present || record !== null;
  return { shown, dormant: shown && !present && record !== null, working };
}

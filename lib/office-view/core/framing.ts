/**
 * office-view/core/framing — what the camera has to show.
 *
 * Extracted because it got this wrong twice. First the shot widened for a crowd but stayed
 * pointed at the middle of the building, so fifty agents gathered in one department were
 * "included" by a frame that had grown in every direction and still had them against its
 * edge. Then it centred correctly but sized itself from half the wider side of the box,
 * which under-covers, and they ran off the edge again.
 *
 * Both were arithmetic mistakes living inside a render loop, where the only way to catch
 * them was to look at a screenshot and squint. Here they can be tested.
 */

import type { World } from './types.ts';

/** A rectangle in world space, or nothing when the floor is empty. */
export type CrowdBox = { minX: number; maxX: number; minY: number; maxY: number } | null;

export type Frame = {
  /** Where the camera should look. */
  at: World;
  /** The distance from that point which must be visible. */
  radius: number;
};

/**
 * Frame the office together with everyone standing in it.
 *
 * The plan is described as a centre and a radius — how far the furniture reaches — and the
 * crowd as the box people actually occupy, which is not the same thing: a department has
 * three desks and a burst of concurrent agents stands well beyond them.
 *
 * With nobody outside the building the result is exactly the plan's own centre and radius,
 * so the ordinary office is framed as it always was and nothing drifts. The moment somebody
 * stands outside, the frame moves to hold both.
 *
 * `margin` is the air left around the outermost person, so they are inside the frame rather
 * than on its edge.
 */
export function frameOffice(
  planCentre: World,
  planRadius: number,
  crowd: CrowdBox,
  margin = 1,
): Frame {
  if (!crowd) return { at: planCentre, radius: planRadius };

  // The union of the building's own square and the crowd's box.
  const minX = Math.min(planCentre.x - planRadius, crowd.minX - margin);
  const maxX = Math.max(planCentre.x + planRadius, crowd.maxX + margin);
  const minY = Math.min(planCentre.y - planRadius, crowd.minY - margin);
  const maxY = Math.max(planCentre.y + planRadius, crowd.maxY + margin);
  const at = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  /*
   * A true bounding radius from the new centre — the distance that has to fit, not half
   * the box's width. The frame is not a square around the target, so half-the-wider-side
   * under-covers a wide crowd.
   *
   * The plan is measured as a radius rather than as a square for one specific reason: it
   * makes the no-crowd case exact. Were it measured corner-wise, an empty office would
   * demand planRadius * sqrt(2) and every existing shot would pull back by 41%.
   */
  let radius = Math.hypot(at.x - planCentre.x, at.y - planCentre.y) + planRadius;
  for (const x of [crowd.minX - margin, crowd.maxX + margin]) {
    for (const y of [crowd.minY - margin, crowd.maxY + margin]) {
      radius = Math.max(radius, Math.hypot(x - at.x, y - at.y));
    }
  }

  return { at, radius };
}

/**
 * office-view/core/figure — how much floor a person takes up.
 *
 * This exists because the seating rule and the drawn figure disagreed, and nothing could
 * catch it: the scheduler fanned extra workers around a desk at 0.55 world units while the
 * renderer drew each of them 0.80 wide, so several agents at one desk intersected by 0.25
 * BY CONSTRUCTION — arithmetic, not tuning. A real session with five parallel subagents
 * rendered them as a single blob of overlapping heads.
 *
 * The number lives here, in core, because two very different places need to agree on it:
 * the scheduler, which decides where a worker stands, and the renderer, which decides how
 * big a worker is drawn. Either one alone is a half-truth. This is the same lesson as
 * `attribution.ts` — when the same rule is implemented twice in different words, the third
 * place that needs it will be the one that does not have it.
 */

/**
 * The widest part of a drawn worker, as a diameter in world (tile) units.
 *
 * Derived from the figure in `three/stage-scene.ts#buildWorker`, whose widest feature is
 * not the head (a sphere of radius 0.34) but the ears — spheres of radius 0.10 centred at
 * x = ±0.30, so the silhouette reaches ±0.40. The arms come to about the same place.
 *
 * `buildWorker` derives the ear offset back from this constant, so the drawn figure and
 * the space reserved for it cannot drift apart again.
 */
export const WORKER_DIAMETER = 0.8;

/** Half of the above, which is what most placement maths actually wants. */
export const WORKER_RADIUS = WORKER_DIAMETER / 2;

/**
 * The gap to leave between two workers standing near each other.
 *
 * A shade more than touching. Two figures exactly `WORKER_DIAMETER` apart are tangent,
 * which still reads as a pile from an isometric camera because the near one occludes the
 * far one's silhouette; a little air makes them read as two people.
 */
export const WORKER_CLEARANCE = WORKER_DIAMETER * 1.15;

/**
 * The step between standing positions when a department's desks are all taken.
 *
 * A shade more than the clearance between two people, so a row of standing agents reads as
 * a queue of individuals rather than a huddle.
 */
export const SPOT_PITCH = WORKER_CLEARANCE * 1.15;

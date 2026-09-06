/**
 * office-view/core/projection — world space to screen space.
 *
 * 2:1 dimetric rather than true 30° isometric. The reason is practical: with a tile
 * exactly twice as wide as it is tall, floor diamonds, room edges and tile seams land on
 * clean values instead of irrational ones, and that precision is most of what makes a
 * miniature model read as *built* rather than sloppy. `validateFloorPlan` enforces the
 * 2:1 ratio so a plan cannot quietly break it.
 *
 * The forward transform is:
 *
 *     sx = (x - y) * tileW / 2
 *     sy = (x + y) * tileH / 2  -  z * tileZ
 *
 * Painter's depth is `x + y` (see `depthOf` in plan.ts), which is why `sy` and depth move
 * together: things further from the camera sit higher on screen and paint earlier.
 *
 * Boundary rule: imports nothing but its own types.
 */

import type { FloorPlan, World } from './types.ts';

export type Screen = { sx: number; sy: number };
export type Tile = FloorPlan['tile'];

/** Project a world position to screen pixels, relative to the world origin. */
export function worldToScreen(at: World, tile: Tile): Screen {
  return {
    sx: (at.x - at.y) * (tile.w / 2),
    sy: (at.x + at.y) * (tile.h / 2) - (at.z ?? 0) * tile.z,
  };
}

/**
 * Inverse projection, assuming ground level (`z = 0`).
 *
 * Needed for click-on-empty-floor-to-deselect and for camera framing. Deriving it:
 * from `sx = (x - y) * w/2` we get `x - y = 2·sx/w`, and from `sy = (x + y) * h/2` we get
 * `x + y = 2·sy/h`. Adding and halving gives x; subtracting and halving gives y.
 */
export function screenToWorld(screen: Screen, tile: Tile): World {
  return {
    x: screen.sx / tile.w + screen.sy / tile.h,
    y: screen.sy / tile.h - screen.sx / tile.w,
  };
}

/** Linear interpolation between two world positions. */
export function lerpWorld(from: World, to: World, t: number): World {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: (from.z ?? 0) + ((to.z ?? 0) - (from.z ?? 0)) * t,
  };
}

export type Bounds = { minX: number; minY: number; width: number; height: number };

/**
 * Screen-space bounding box of everything in a plan, with padding.
 *
 * This becomes the SVG `viewBox`, which is how the camera works: pan, zoom and
 * focus-on-a-desk are all one tweened 4-tuple rather than per-entity work. That is also
 * why zooming into a desk stays perfectly crisp — nothing is re-rasterised.
 */
export function planBounds(plan: FloorPlan, padding = 1.5): Bounds {
  const points: World[] = [
    ...plan.rooms.flatMap((room) => [
      room.origin,
      { x: room.origin.x + room.size.w, y: room.origin.y + room.size.h },
      { x: room.origin.x + room.size.w, y: room.origin.y },
      { x: room.origin.x, y: room.origin.y + room.size.h },
    ]),
    ...plan.stations.flatMap((s) => [s.seat, s.inTray, s.outTray]),
    ...plan.aisle.nodes.map((n) => n.at),
    ...plan.doors.map((d) => d.at),
    plan.inbox.at,
    plan.outbox.at,
  ];

  const projected = points.map((point) => worldToScreen(point, plan.tile));
  const padX = padding * (plan.tile.w / 2);
  const padY = padding * (plan.tile.h / 2);

  const xs = projected.map((p) => p.sx);
  const ys = projected.map((p) => p.sy);
  const minX = Math.min(...xs) - padX;
  const maxX = Math.max(...xs) + padX;
  // Extra headroom at the top: standing figures and desk furniture rise above their tile.
  const minY = Math.min(...ys) - padY - plan.tile.z;
  const maxY = Math.max(...ys) + padY;

  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/** Format a bounds as an SVG `viewBox` attribute. */
export function toViewBox(bounds: Bounds): string {
  return `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`;
}

/**
 * Frame a single point at a given zoom, for focus-on-a-desk.
 *
 * `zoom` is a multiplier on the *visible area*: 1 shows the whole plan, 3 shows a third
 * of it. Clamped to stay inside the plan so a click near an edge cannot pan the office
 * off screen.
 */
export function focusBounds(plan: FloorPlan, at: World, zoom: number, padding = 1.5): Bounds {
  const full = planBounds(plan, padding);
  const width = full.width / Math.max(zoom, 1);
  const height = full.height / Math.max(zoom, 1);
  const centre = worldToScreen(at, plan.tile);

  const minX = Math.min(Math.max(centre.sx - width / 2, full.minX), full.minX + full.width - width);
  const minY = Math.min(
    Math.max(centre.sy - height / 2, full.minY),
    full.minY + full.height - height,
  );

  return { minX, minY, width, height };
}

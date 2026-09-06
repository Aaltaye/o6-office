import type { PropKind } from '../core/types.ts';

/**
 * office-view/art/theme — the look.
 *
 * The office is a near-monochrome porcelain paper model. Depth comes from flat tonal
 * steps and alpha layering, never from drop shadows or blurs: SVG filters are what
 * actually kill SVG performance on mobile, and a filter-free scene also reads more like
 * a precise architectural model than a rendered game.
 *
 * **O6 Violet is reserved exclusively for "this is happening right now."** Not for
 * branding, not for headings, not for decoration — only the active desk, the folder in
 * transit, the live meter. This is doing two jobs at once: the O6 brand system caps
 * violet at 5% or less of any application, and reserving it for live activity satisfies
 * that cap by construction while making the viewer's eye land on exactly the thing the
 * product exists to show. Form and brand rule turn out to be the same rule.
 *
 * If you are tempted to add a second accent colour, the answer is a tonal step instead.
 *
 * Boundary rule: imports only core types.
 */

/**
 * The authoritative O6 palette. These are the brand-system tokens, not approximations —
 * an earlier build of this app invented its own blue (#3854ef) and was wrong.
 */
export const palette = {
  /** Primary background — the ground the model sits on. */
  porcelain: '#F7F7F4',
  /** Subtle surfaces — desk tops, panels, paper. */
  mist: '#E8E8F0',
  /** Structure — edges, partitions, the shaded faces of things. */
  titanium: '#B6BBC5',
  /** Primary text. */
  graphite: '#1F2228',
  /** Signal. Live activity ONLY. Capped at <=5% of any application. */
  violet: '#7446FF',
} as const;

/**
 * Derived tones for the three visible faces of an isometric box.
 *
 * A single hue stepped in value is what makes flat polygons read as a solid. Top catches
 * the most light; the south face (nearest the viewer) is darkest.
 */
export const faces = {
  top: palette.mist,
  east: '#D8DAE3',
  south: '#C4C8D3',
  /** The floor plane itself, a touch warmer than the furniture. */
  floor: palette.porcelain,
  /** Room footprints, just distinguishable from the floor. */
  room: '#F1F1EE',
  /** Contact shadow: a flat, slightly darker polygon, never a blur. */
  contact: 'rgba(31, 34, 40, 0.06)',
} as const;

/** Live-activity tones. Violet at low alpha for pools of attention, solid for objects. */
export const live = {
  solid: palette.violet,
  /** The light pool that marks the busy desk. Deliberately soft. */
  pool: 'rgba(116, 70, 255, 0.10)',
  edge: 'rgba(116, 70, 255, 0.55)',
  /** A failed check — still violet-family, because it is also "happening now". */
  returning: '#5B34CC',
} as const;

export const strokes = {
  hairline: 0.75,
  edge: 1,
  /** Only used to ring a selected object. */
  focus: 2,
} as const;

/**
 * World-space dimensions, in tile units. Kept here rather than in the floor plan because
 * these are art decisions (how chunky a desk looks), not layout decisions (where it is).
 */
export const geometry = {
  desk: { w: 1.5, d: 0.8, h: 0.42 },
  /** Hot desks read as lighter and more temporary than a permanent station. */
  hotDesk: { w: 1.2, d: 0.7, h: 0.36 },
  tray: { w: 0.42, d: 0.32, h: 0.07 },
  /** A person: capsule body plus a head. Faceless on purpose. */
  worker: { bodyW: 0.34, bodyH: 0.52, headR: 0.15, lift: 0.02 },
  folder: { w: 0.36, d: 0.26, h: 0.05 },
  partition: { h: 0.62, thickness: 0.07 },
  door: { w: 1.1, h: 0.9 },
} as const;

export const PROP_SHAPES: Record<PropKind, { w: number; d: number; h: number }> = {
  cabinet: { w: 0.5, d: 0.45, h: 1.1 }, // tall drawers
  shelf: { w: 1.1, d: 0.3, h: 1.25 }, // wide and tall
  screen: { w: 0.72, d: 0.12, h: 0.62 }, // thin upright panel
  rack: { w: 0.55, d: 0.6, h: 1.35 }, // deepest and tallest
  bench: { w: 1.2, d: 0.55, h: 0.34 }, // low working surface
  stack: { w: 0.34, d: 0.3, h: 0.26 }, // a pile of paper
  board: { w: 1.25, d: 0.1, h: 0.85 }, // flat, wide, upright
  plant: { w: 0.3, d: 0.3, h: 0.5 },
  crate: { w: 0.55, d: 0.55, h: 0.5 },
};

/** Motion timings in ms. Playback-facing, not workflow-facing. */
export const timings = {
  /** Camera tween when focusing a desk. Slow enough to keep orientation. */
  cameraMs: 520,
  /** How long a "just changed" highlight lingers. */
  pulseMs: 900,
} as const;

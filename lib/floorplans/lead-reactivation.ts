/**
 * Floor plan: the lead reactivation office.
 *
 * Six departments arranged in a U around a central aisle, so a lead's folder physically
 * travels down one side and back up the other. Work enters and leaves through the same
 * door at the top, which is what makes "finished work leaves the building" legible
 * without a label.
 *
 * World coordinates are tile units: `x` runs east, `y` runs south. Painter's depth is
 * `x + y`, so a desk further down-right paints in front of one up-left. Two things are
 * worth preserving if you move anything:
 *
 *  - No aisle edge may run along a constant depth (`x + y` equal at both ends), or a
 *    walker's paint layer becomes ambiguous and flickers. `compileFloorPlan` warns.
 *  - No aisle edge may pass within half a tile of a seat, or walkers render through the
 *    furniture. `compileFloorPlan` warns about that too.
 *
 * This module imports only the contract types — it must never learn what a "lead" is
 * beyond the department names a human reads.
 */

import type { FloorPlan } from '../office-view/core/types.ts';

/** Desks on the west side of the aisle face east, toward it, and vice versa. */
const WEST_X = 4;
const EAST_X = 10;
const AISLE_X = 7;

/** How far a tray sits from its desk, toward the aisle. */
const TRAY_OFFSET = 1.2;

/**
 * The six departments, in the order work flows through them. Rows are chosen so that
 * the route is a U: down the west side, across, and back up the east side.
 */
const DEPARTMENTS = [
  { id: 'records', role: 'Records', side: 'west', row: 3, node: 'aisle-upper' },
  { id: 'context', role: 'Context', side: 'west', row: 6, node: 'aisle-middle' },
  { id: 'research', role: 'Research', side: 'west', row: 9, node: 'aisle-lower' },
  { id: 'opportunity', role: 'Opportunity', side: 'east', row: 9, node: 'aisle-lower' },
  { id: 'outreach', role: 'Outreach', side: 'east', row: 6, node: 'aisle-middle' },
  { id: 'review', role: 'Review', side: 'east', row: 3, node: 'aisle-upper' },
] as const;

/**
 * Hot desks for bounded specialists. In this workflow a specialist is a scoped model
 * assignment (Context, Outreach or Review running as a separate call), so at most three
 * can be present at once; two hot desks plus overflow is deliberate — the office should
 * feel like it has finite capacity, because it does.
 */
const HOT_DESKS = [
  { id: 'visitor-1', column: 5.5 },
  { id: 'visitor-2', column: 8.5 },
] as const;

const HOT_DESK_ROW = 11.5;

function station(dept: (typeof DEPARTMENTS)[number]) {
  const west = dept.side === 'west';
  const x = west ? WEST_X : EAST_X;
  // Trays sit on the aisle side of the desk: work arrives from the corridor and leaves
  // back into it, which is what makes a handoff read as carrying rather than teleporting.
  const trayX = west ? x + TRAY_OFFSET : x - TRAY_OFFSET;
  return {
    id: dept.id,
    room: `room-${dept.id}`,
    role: dept.role,
    seat: { x, y: dept.row },
    facing: (west ? 'e' : 'w') as 'e' | 'w',
    inTray: { x: trayX, y: dept.row - 0.6 },
    outTray: { x: trayX, y: dept.row + 0.6 },
    node: dept.node,
  };
}

function room(dept: (typeof DEPARTMENTS)[number]) {
  const west = dept.side === 'west';
  return {
    id: `room-${dept.id}`,
    label: dept.role,
    origin: { x: west ? WEST_X - 1.5 : EAST_X - 1.5, y: dept.row - 1.5 },
    size: { w: 3, h: 3 },
  };
}

export const leadReactivationPlan: FloorPlan = {
  id: 'lead-reactivation',
  version: 1,
  label: 'Lead reactivation office',
  // 2:1 dimetric. Exact 2:1 keeps floor diamonds and room edges on clean pixel values,
  // which is most of what makes the model read as precise rather than sloppy.
  tile: { w: 64, h: 32, z: 24 },

  rooms: [
    ...DEPARTMENTS.map(room),
    { id: 'room-visitors', label: 'Visiting specialists', origin: { x: 4, y: 10.5 }, size: { w: 6, h: 2.5 } },
    { id: 'room-front', label: 'Front desk', origin: { x: 3.5, y: 0 }, size: { w: 7, h: 2 } },
  ],

  stations: [
    ...DEPARTMENTS.map(station),
    ...HOT_DESKS.map((desk) => ({
      id: desk.id,
      room: 'room-visitors',
      role: 'Specialist',
      seat: { x: desk.column, y: HOT_DESK_ROW },
      facing: 'n' as const,
      inTray: { x: desk.column - 0.6, y: HOT_DESK_ROW - 0.8 },
      outTray: { x: desk.column + 0.6, y: HOT_DESK_ROW - 0.8 },
      hotDesk: true,
      node: 'aisle-foot',
    })),
  ],

  // Exactly one entrance: specialists walk in and out through it, and so does the work.
  doors: [{ id: 'front', at: { x: AISLE_X, y: 0 }, facing: 's', entrance: true }],

  aisle: {
    nodes: [
      { id: 'aisle-door', at: { x: AISLE_X, y: 0.5 } },
      { id: 'aisle-front', at: { x: AISLE_X, y: 1.5 } },
      { id: 'aisle-upper', at: { x: AISLE_X, y: 3 } },
      { id: 'aisle-middle', at: { x: AISLE_X, y: 6 } },
      { id: 'aisle-lower', at: { x: AISLE_X, y: 9 } },
      { id: 'aisle-foot', at: { x: AISLE_X, y: 10.5 } },
    ],
    // Every edge changes `y`, so depth strictly increases along it — no constant-depth
    // segments, no ambiguous bands. `lanes: 3` lets three folders travel abreast before
    // the renderer aggregates them into a single cart with a count badge.
    edges: [
      { from: 'aisle-door', to: 'aisle-front', lanes: 3 },
      { from: 'aisle-front', to: 'aisle-upper', lanes: 3 },
      { from: 'aisle-upper', to: 'aisle-middle', lanes: 3 },
      { from: 'aisle-middle', to: 'aisle-lower', lanes: 3 },
      { from: 'aisle-lower', to: 'aisle-foot', lanes: 3 },
    ],
  },

  // Work arrives on the west of the front desk and leaves from the east, so the two
  // trays never read as the same pile.
  inbox: { at: { x: 4.6, y: 1 }, node: 'aisle-front' },
  outbox: { at: { x: 9.4, y: 1 }, node: 'aisle-front' },
};

/**
 * Mobile variant: the same office, stacked into one column.
 *
 * Station ids are identical to the parent plan, which is the whole point — a run
 * recorded on the desktop layout renders unchanged here. Only geometry differs, so this
 * costs nothing but data (PLAN.md A8). Below ~640px the wide U becomes unreadable label
 * soup; a single column keeps the flow legible top to bottom.
 */
export const leadReactivationCompactPlan: FloorPlan = {
  id: 'lead-reactivation-compact',
  version: 1,
  label: 'Lead reactivation office (compact)',
  variantOf: 'lead-reactivation',
  tile: { w: 48, h: 24, z: 18 },

  // Spread rather than `.concat`: the const-asserted DEPARTMENTS narrows `label` to the
  // six department names, and concat would then reject the two extra rooms.
  rooms: [
    ...DEPARTMENTS.map((dept, i) => ({
      id: `room-${dept.id}`,
      label: dept.role as string,
      origin: { x: 1.5, y: 2 + i * 2 - 0.75 },
      size: { w: 5, h: 1.8 },
    })),
    { id: 'room-visitors', label: 'Visiting specialists', origin: { x: 1.5, y: 14 }, size: { w: 5, h: 2 } },
    { id: 'room-front', label: 'Front desk', origin: { x: 1.5, y: 0 }, size: { w: 5, h: 1.5 } },
  ],

  stations: [
    ...DEPARTMENTS.map((dept, i) => ({
      id: dept.id,
      room: `room-${dept.id}`,
      role: dept.role,
      seat: { x: 3, y: 2 + i * 2 },
      facing: 'e' as const,
      inTray: { x: 4.2, y: 2 + i * 2 - 0.5 },
      outTray: { x: 4.2, y: 2 + i * 2 + 0.5 },
      node: `column-${i}`,
    })),
    ...HOT_DESKS.map((desk, i) => ({
      id: desk.id,
      room: 'room-visitors',
      role: 'Specialist',
      seat: { x: 2.5 + i * 1.8, y: 14.5 },
      facing: 'n' as const,
      inTray: { x: 2.5 + i * 1.8 - 0.5, y: 13.9 },
      outTray: { x: 2.5 + i * 1.8 + 0.5, y: 13.9 },
      hotDesk: true,
      node: 'column-foot',
    })),
  ],

  doors: [{ id: 'front', at: { x: 5.5, y: 0.2 }, facing: 's', entrance: true }],

  aisle: {
    nodes: [
      { id: 'column-door', at: { x: 5.5, y: 0.6 } },
      ...DEPARTMENTS.map((_, i) => ({ id: `column-${i}`, at: { x: 5.5, y: 2 + i * 2 } })),
      { id: 'column-foot', at: { x: 5.5, y: 13.5 } },
    ],
    edges: [
      { from: 'column-door', to: 'column-0', lanes: 2 },
      ...DEPARTMENTS.slice(1).map((_, i) => ({
        from: `column-${i}`,
        to: `column-${i + 1}`,
        lanes: 2,
      })),
      { from: `column-${DEPARTMENTS.length - 1}`, to: 'column-foot', lanes: 2 },
    ],
  },

  inbox: { at: { x: 2, y: 0.5 }, node: 'column-door' },
  outbox: { at: { x: 4.4, y: 0.5 }, node: 'column-door' },
};

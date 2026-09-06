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

import type { FloorPlan, PropKind, World } from '../office-view/core/types.ts';
/**
 * What each department is made of.
 *
 * A company is legible because its rooms are not interchangeable — you know the archive
 * from the mailroom by looking. Six identical desks would make this a labelled diagram;
 * giving each department its own furniture makes it a place.
 *
 * Offsets are relative to the desk's seat. A negative y is behind the desk, where things
 * stand without hiding whoever is working.
 */
const DEPARTMENT_PROPS: Record<string, { kind: PropKind; at: World; layer?: 'back' | 'front' }[]> = {
  // Records keeps things: drawers, and a crate of what has not been filed yet.
  records: [
    { kind: 'cabinet', at: { x: -0.7, y: -1.05 } },
    { kind: 'cabinet', at: { x: -0.1, y: -1.05 } },
    { kind: 'crate', at: { x: 0.75, y: -0.95 } },
  ],
  // Context reads the history, so it is the room with the shelf.
  context: [
    { kind: 'shelf', at: { x: -0.25, y: -1.1 } },
    { kind: 'stack', at: { x: 0.8, y: -0.85 } },
  ],
  // Research traces claims back to sources: a screen and something to pin findings to.
  research: [
    { kind: 'screen', at: { x: -0.55, y: -1.05 } },
    { kind: 'board', at: { x: 0.45, y: -1.15 } },
  ],
  // Opportunity is where the judgement happens — a board, and a plant to soften it.
  opportunity: [
    { kind: 'board', at: { x: -0.3, y: -1.15 } },
    { kind: 'plant', at: { x: 0.95, y: -0.9 } },
  ],
  // Outreach writes: paper, and a screen to write it on.
  outreach: [
    { kind: 'screen', at: { x: -0.55, y: -1.05 } },
    { kind: 'stack', at: { x: 0.25, y: -0.9 } },
    { kind: 'stack', at: { x: 0.7, y: -0.85 } },
  ],
  // Review checks and decides: a board, the files it checks against, a plant by the door.
  review: [
    { kind: 'board', at: { x: -0.35, y: -1.15 } },
    { kind: 'cabinet', at: { x: 0.7, y: -1.05 } },
    { kind: 'plant', at: { x: -1.0, y: 0.55 }, layer: 'front' },
  ],
};


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
    props: DEPARTMENT_PROPS[dept.id],
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
 * Mobile variant: the same office, marching straight down the screen.
 *
 * Station ids are identical to the parent plan, which is the whole point — a run
 * recorded on the desktop layout renders unchanged here. Only geometry differs, so this
 * costs nothing but data (PLAN.md A8).
 *
 * The non-obvious part is what "a single column" means under isometric projection.
 * Screen-x is `(x - y)` and screen-y is `(x + y)`, so holding *world* x constant and
 * increasing y walks diagonally down-left across the viewport and wastes a portrait
 * screen. To march straight DOWN the screen you hold `x - y` constant and increase both
 * together — which is why every desk below sits at `(n + OFFSET, n)`.
 */
export const leadReactivationCompactPlan: FloorPlan = {
  id: 'lead-reactivation-compact',
  version: 1,
  label: 'Lead reactivation office (compact)',
  variantOf: 'lead-reactivation',
  tile: { w: 48, h: 24, z: 20 },

  // Desks march straight down the screen: `x - y` is constant, so only depth changes.
  // Spread rather than `.concat` — the const-asserted DEPARTMENTS narrows `label` to the
  // six department names, and concat would then reject the two extra rooms.
  rooms: [
    ...DEPARTMENTS.map((dept, i) => ({
      id: `room-${dept.id}`,
      label: dept.role as string,
      origin: { x: 2 + i * 1.6 - 1, y: i * 1.6 - 1 },
      size: { w: 2, h: 2 },
    })),
    { id: 'room-visitors', label: 'Visiting specialists', origin: { x: 11.6, y: 9.6 }, size: { w: 2.4, h: 2.4 } },
    { id: 'room-front', label: 'Front desk', origin: { x: 1, y: -2.4 }, size: { w: 2.4, h: 2 } },
  ],

  stations: [
    ...DEPARTMENTS.map((dept, i) => ({
      id: dept.id,
      room: `room-${dept.id}`,
      role: dept.role,
      seat: { x: 2 + i * 1.6, y: i * 1.6 },
      // All desks face the same way in a single file, so the column reads as one queue.
      facing: 'e' as const,
      inTray: { x: 2 + i * 1.6 + 0.75, y: i * 1.6 - 0.15 },
      outTray: { x: 2 + i * 1.6 + 0.15, y: i * 1.6 + 0.75 },
      node: `column-${i}`,
    })),
    ...HOT_DESKS.map((desk, i) => ({
      id: desk.id,
      room: 'room-visitors',
      role: 'Specialist',
      seat: { x: 12.4 + i * 0.5, y: 10.4 - i * 0.5 },
      facing: 'n' as const,
      inTray: { x: 12.0 + i * 0.5, y: 10.0 - i * 0.5 },
      outTray: { x: 12.8 + i * 0.5, y: 10.8 - i * 0.5 },
      hotDesk: true,
      node: 'column-foot',
    })),
  ],

  doors: [{ id: 'front', at: { x: 1.4, y: -1.4 }, facing: 's', entrance: true }],

  aisle: {
    // Offset from the desks by a constant `x - y`, so the corridor runs parallel to the
    // column and every edge still changes depth (no constant-depth segments).
    nodes: [
      { id: 'column-door', at: { x: 2.1, y: -1.1 } },
      ...DEPARTMENTS.map((_, i) => ({ id: `column-${i}`, at: { x: 3.1 + i * 1.6, y: i * 1.6 } })),
      { id: 'column-foot', at: { x: 11.9, y: 8.8 } },
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

  inbox: { at: { x: 1.3, y: -1.9 }, node: 'column-door' },
  outbox: { at: { x: 2.7, y: -0.5 }, node: 'column-door' },
};

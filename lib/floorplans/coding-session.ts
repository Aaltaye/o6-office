/**
 * Floor plan: the coding-session office.
 *
 * A coding session's departments are not a lead workflow's. Reusing the six lead desks
 * would have been easy and would have been a lie — nobody's Claude Code session has an
 * "Opportunity" desk. These are the places work actually goes: reading the codebase,
 * making edits, running commands, looking things up, and waiting on the human.
 *
 * Two deliberate differences from the lead office:
 *
 *  - **Three hot desks, not two.** Subagents are the most interesting thing that happens
 *    in a coding session, so the office has room to show several at once before it has
 *    to start summarising.
 *  - **Approvals sits by the door.** A permission request is the one moment the session
 *    stops and waits for a person, so it belongs where a person would walk in.
 *
 * The same geometry rules apply as the lead office: no aisle edge along a constant depth
 * (`x + y` equal at both ends) and none passing within half a tile of a seat.
 * `compileFloorPlan` warns about both.
 */

import type { FloorPlan } from '../office-view/core/types.ts';

const WEST_X = 4;
const EAST_X = 10;
const AISLE_X = 7;
const TRAY_OFFSET = 1.2;

/**
 * The departments of a coding session, in roughly the order work passes through them.
 * `id` values are what the hook mapping emits, so they are part of the contract between
 * the bridge and this plan.
 */
const DEPARTMENTS = [
  { id: 'frontdesk', role: 'Front desk', side: 'west', row: 3, node: 'aisle-upper' },
  { id: 'reading', role: 'Reading room', side: 'west', row: 6, node: 'aisle-middle' },
  { id: 'research', role: 'Research', side: 'west', row: 9, node: 'aisle-lower' },
  { id: 'operations', role: 'Operations', side: 'east', row: 9, node: 'aisle-lower' },
  { id: 'workshop', role: 'Workshop', side: 'east', row: 6, node: 'aisle-middle' },
  { id: 'approvals', role: 'Approvals', side: 'east', row: 3, node: 'aisle-upper' },
] as const;

/** Subagents take these. Three, because a session can easily have several at once. */
const HOT_DESKS = [
  { id: 'visitor-1', column: 4.6 },
  { id: 'visitor-2', column: 7 },
  { id: 'visitor-3', column: 9.4 },
] as const;

const HOT_DESK_ROW = 11.5;

function station(dept: (typeof DEPARTMENTS)[number]) {
  const west = dept.side === 'west';
  const x = west ? WEST_X : EAST_X;
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

export const codingSessionPlan: FloorPlan = {
  id: 'coding-session',
  version: 1,
  label: 'Coding session office',
  tile: { w: 64, h: 32, z: 24 },

  // Nobody is assumed. A live session's cast is whatever is actually running — one agent,
  // or one agent and however many subagents it spawned — and they walk to whichever desk
  // their current work is at. Seating a fixed six-person team here, the way the lead
  // office does, would populate the floor with people who do not exist.
  staffing: 'dynamic',

  rooms: [
    ...DEPARTMENTS.map((dept) => ({
      id: `room-${dept.id}`,
      label: dept.role as string,
      origin: { x: (dept.side === 'west' ? WEST_X : EAST_X) - 1.5, y: dept.row - 1.5 },
      size: { w: 3, h: 3 },
    })),
    { id: 'room-visitors', label: 'Subagents', origin: { x: 3.4, y: 10.5 }, size: { w: 7.2, h: 2.5 } },
    { id: 'room-front', label: 'Entrance', origin: { x: 3.5, y: 0 }, size: { w: 7, h: 2 } },
  ],

  stations: [
    ...DEPARTMENTS.map(station),
    ...HOT_DESKS.map((desk) => ({
      id: desk.id,
      room: 'room-visitors',
      role: 'Subagent',
      seat: { x: desk.column, y: HOT_DESK_ROW },
      facing: 'n' as const,
      inTray: { x: desk.column - 0.55, y: HOT_DESK_ROW - 0.8 },
      outTray: { x: desk.column + 0.55, y: HOT_DESK_ROW - 0.8 },
      hotDesk: true,
      node: 'aisle-foot',
    })),
  ],

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
    edges: [
      { from: 'aisle-door', to: 'aisle-front', lanes: 3 },
      { from: 'aisle-front', to: 'aisle-upper', lanes: 3 },
      { from: 'aisle-upper', to: 'aisle-middle', lanes: 3 },
      { from: 'aisle-middle', to: 'aisle-lower', lanes: 3 },
      { from: 'aisle-lower', to: 'aisle-foot', lanes: 3 },
    ],
  },

  // A prompt arrives at the inbox; finished turns collect in the outbox.
  inbox: { at: { x: 4.6, y: 1 }, node: 'aisle-front' },
  outbox: { at: { x: 9.4, y: 1 }, node: 'aisle-front' },
};

/** Every station id this plan defines, for the mapping to validate itself against. */
export const CODING_STATIONS = codingSessionPlan.stations.map((s) => s.id);

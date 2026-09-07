/**
 * office-view/core/seating — which desk an agent gets.
 *
 * A department used to be one desk, so "where does this agent sit" had no answer worth
 * asking: everybody was sent to the same coordinate and the renderer drew them inside one
 * another. Now a department is a row of desks and somebody has to hand them out.
 *
 * The rules are deliberately dull, because the interesting-sounding versions are the ones
 * that lie:
 *
 *  - A desk is claimed on FREE-OR-NOT and nothing else. Seat choice never considers who
 *    used a desk before or what they left behind; the moment allocation depends on history,
 *    clearing that history silently reseats people who are already on screen.
 *  - Releasing a desk writes a hole, it never splices the list. Splicing would renumber
 *    every claim after it, which would teleport agents who have not moved.
 *  - An agent that already holds a desk in a department keeps it. Re-deriving a seat on
 *    every event would make an agent hop between desks while doing one job.
 *  - Nobody is ever turned away. If a department's desks are all taken, the extra agent
 *    stands in that department, clear of the furniture, and is still reported as being
 *    there. Dropping someone off the floor because the furniture ran out would be the
 *    office lying about who is working.
 *
 * Pure and deterministic: same claim order in, same seats out, so a replay seats everybody
 * exactly where the live run did.
 */

import type { CompiledPlan } from './plan.ts';
import type { RoomId, StationId, WorkerId, World } from './types.ts';
import { SPOT_PITCH, WORKER_CLEARANCE } from './figure.ts';

/**
 * Who is sitting where.
 *
 * One sparse array per department, indexed by desk order. A null is a free desk, and it
 * stays in place so the desks after it keep their numbers.
 */
export type SeatClaims = {
  byRoom: Map<RoomId, (WorkerId | null)[]>;
  ofWorker: Map<WorkerId, { room: RoomId; index: number }>;
};

export function newClaims(): SeatClaims {
  return { byRoom: new Map(), ofWorker: new Map() };
}

/** The desks of a department, in plan order, primary first. */
function desksOf(compiled: CompiledPlan, room: RoomId): StationId[] {
  return compiled.roomStations.get(room) ?? [];
}

export type Claim = {
  /** The desk they got, or null when the department's desks were all taken. */
  deskId: StationId | null;
  /** Their place in the department: 0..n-1 is a desk, n and beyond is standing room. */
  index: number;
  room: RoomId;
};

/**
 * Give a worker a desk in a department, or standing room in it if the desks are full.
 *
 * Idempotent for a worker already seated in this department — they keep the desk they are
 * at, because an agent doing one job should not shuffle between desks while doing it.
 */
export function claimDesk(
  claims: SeatClaims,
  compiled: CompiledPlan,
  station: StationId,
  worker: WorkerId,
): Claim | null {
  const room = compiled.roomOf.get(station);
  if (!room) return null;

  const held = claims.ofWorker.get(worker);
  if (held && held.room === room) {
    return { deskId: desksOf(compiled, room)[held.index] ?? null, index: held.index, room };
  }
  // Moving department: let go of the old desk before taking a new one.
  if (held) releaseWorker(claims, worker);

  const seats = claims.byRoom.get(room) ?? [];
  claims.byRoom.set(room, seats);

  let index = seats.findIndex((occupant) => occupant === null);
  if (index === -1) {
    index = seats.length;
    seats.push(worker);
  } else {
    seats[index] = worker;
  }
  claims.ofWorker.set(worker, { room, index });

  return { deskId: desksOf(compiled, room)[index] ?? null, index, room };
}

/** Let go of whatever desk this worker held. Leaves a hole rather than renumbering. */
export function releaseWorker(claims: SeatClaims, worker: WorkerId): void {
  const held = claims.ofWorker.get(worker);
  if (!held) return;
  const seats = claims.byRoom.get(held.room);
  if (seats && seats[held.index] === worker) seats[held.index] = null;
  claims.ofWorker.delete(worker);
}

/** The desk this worker currently holds, if any. */
export function deskOf(claims: SeatClaims, compiled: CompiledPlan, worker: WorkerId): StationId | null {
  const held = claims.ofWorker.get(worker);
  if (!held) return null;
  return desksOf(compiled, held.room)[held.index] ?? null;
}

/**
 * Where somebody stands when their department's desks are all taken.
 *
 * A lane inside the department, in front of its desks, stepping outward in the same
 * direction the desks run. Deterministic from the index alone, so a replay stands them in
 * the same place, and far enough from the desk row that a standing figure never intersects
 * a seated one.
 *
 * This is standing room, not a desk, and the office reports it as such — the alternative
 * was to drop the agent, which would be the floor claiming less work is happening than is.
 */
export function overflowSpot(
  compiled: CompiledPlan,
  room: RoomId,
  index: number,
): World | null {
  const desks = desksOf(compiled, room);
  const primary = compiled.plan.stations.find((station) => station.id === desks[0]);
  const rect = compiled.plan.rooms.find((candidate) => candidate.id === room);
  if (!primary || !rect) return null;

  // Which way the desks run: away from the aisle, the same direction the satellites went.
  const last = compiled.plan.stations.find((station) => station.id === desks[desks.length - 1]);
  const direction = last && last.seat.x < primary.seat.x ? -1 : 1;
  const overflow = Math.max(0, index - desks.length);

  /*
   * A clear lane in front of the desk row. The desks sit on the room's centre line, are
   * 0.8 deep and a figure is WORKER_CLEARANCE across, so a lane this far forward cannot
   * intersect a seated worker however the desks are arranged.
   */
  const lane = primary.seat.y + 0.8 + WORKER_CLEARANCE / 2;
  const x = primary.seat.x + direction * SPOT_PITCH * overflow;

  // Stay inside the department's own floor; past the end, stack a second lane rather than
  // walking out of the room.
  const withinRoom = x >= rect.origin.x && x <= rect.origin.x + rect.size.w;
  return withinRoom
    ? { x, y: lane }
    : { x: primary.seat.x + direction * SPOT_PITCH * (overflow % 3), y: lane + SPOT_PITCH };
}

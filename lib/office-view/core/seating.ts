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
import { DESK_OFFSET, SPOT_PITCH, WORKER_CLEARANCE } from './figure.ts';

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
 * A lattice, generated outward from the department and filtered so no spot lands on
 * furniture, on somebody else's desk, or in the central corridor. Deterministic from the
 * index alone, so a replay stands everybody in the same place.
 *
 * The first version of this was a single lane with a three-position fallback, which was
 * fine for the fourth agent in a department and catastrophic for the fortieth: fifty
 * concurrent agents collapsed onto eleven positions, fourteen of them on one spot — the
 * exact pile this module exists to prevent, reintroduced past the edge of the lane. A
 * lattice has no edge to fall off.
 *
 * Standing room is deliberately unbounded. The alternative is to stop drawing people once
 * the furniture runs out, and an office that shows thirty of the fifty agents that are
 * working is lying by a wider margin than one that looks crowded.
 */

/**
 * Cached per plan: generating the lattices is pure, so it only has to be done once.
 *
 * Keyed by the plan's id as well as the room's, because two plans can legitimately use the
 * same room id and must not inherit each other's floor.
 */
const lattices = new Map<string, Map<RoomId, World[]>>();

/**
 * Standing positions for every department, as disjoint sets.
 *
 * Built as ONE grid over the whole floor and then divided up, each cell going to the
 * department whose centre it is nearest. Computing a lattice per department independently
 * was the obvious approach and it is wrong: two neighbouring crowds grow outward into the
 * same cells and start overlapping again once either is big enough — measured at 120
 * concurrent agents, fourteen overlapping pairs, some 0.17 apart. Dividing the floor up
 * first makes that impossible by construction rather than by tuning.
 */
function latticesFor(compiled: CompiledPlan): Map<RoomId, World[]> {
  const cached = lattices.get(compiled.plan.id);
  if (cached) return cached;

  const departments = compiled.plan.rooms.filter(
    (candidate) => (candidate.kind ?? 'department') === 'department',
  );
  const centres = departments.map((candidate) => ({
    room: candidate.id,
    at: {
      x: candidate.origin.x + candidate.size.w / 2,
      y: candidate.origin.y + candidate.size.h / 2,
    },
  }));

  // The corridor everyone walks down. Standing in it would block the one route through.
  const aisleXs = compiled.plan.aisle.nodes.map((node) => node.at.x);
  const corridor = aisleXs.length ? aisleXs.reduce((a, b) => a + b, 0) / aisleXs.length : null;

  const standable = (at: World) => {
    if (corridor !== null && Math.abs(at.x - corridor) < 1.2) return false;
    // Never on a desk or on whoever is sitting at one — in ANY department.
    for (const station of compiled.plan.stations) {
      if (Math.hypot(at.x - station.seat.x, at.y - station.seat.y) < WORKER_CLEARANCE * 1.4) {
        return false;
      }
      /*
       * Nor inside that desk's own furniture. Prop offsets are relative to the DESK, which
       * sits DESK_OFFSET in front of the seat along the station's facing — the same basis
       * the renderer uses. Measuring them from the seat instead put the exclusion zone
       * most of a tile away from the actual rack, and the fifteenth agent in Operations
       * stood inside it.
       */
      const facing = station.facing === 'w' ? -1 : station.facing === 'e' ? 1 : 0;
      const desk = { x: station.seat.x + facing * DESK_OFFSET, y: station.seat.y };
      for (const prop of station.props ?? []) {
        const propAt = { x: desk.x + prop.at.x, y: desk.y + prop.at.y };
        if (Math.hypot(at.x - propAt.x, at.y - propAt.y) < WORKER_CLEARANCE) return false;
      }
    }
    /*
     * And clear of the waiting lounge, which fills from its own centre by a separate rule.
     * Two placement systems that do not know about each other will eventually put two
     * people in the same place, and this one is the one that can move.
     */
    for (const lounge of compiled.plan.rooms) {
      if (lounge.kind !== 'waiting') continue;
      const centre = {
        x: lounge.origin.x + lounge.size.w / 2,
        y: lounge.origin.y + lounge.size.h / 2,
      };
      // Generous: the lounge ring grows, so reserve the room rather than a fixed radius.
      const reach = Math.max(lounge.size.w, lounge.size.h) / 2 + WORKER_CLEARANCE;
      if (Math.hypot(at.x - centre.x, at.y - centre.y) < reach) return false;
    }
    return true;
  };

  /*
   * A grid big enough that it never runs out. It is generated once, and the office is only
   * ever as large as the people actually standing in it — an empty cell draws nothing.
   */
  const bounds = compiled.plan.rooms.reduce(
    (box, candidate) => ({
      minX: Math.min(box.minX, candidate.origin.x),
      minY: Math.min(box.minY, candidate.origin.y),
      maxX: Math.max(box.maxX, candidate.origin.x + candidate.size.w),
      maxY: Math.max(box.maxY, candidate.origin.y + candidate.size.h),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  // Room to spill well past the walls, because a genuinely crowded office should look it.
  const margin = SPOT_PITCH * 8;

  const cells: World[] = [];
  // Integer steps, so the grid cannot drift: `x += SPOT_PITCH` in a loop accumulates
  // floating-point error and would generate a different cell set on a long enough floor.
  const cols = Math.ceil((bounds.maxX - bounds.minX + margin * 2) / SPOT_PITCH);
  const rows = Math.ceil((bounds.maxY - bounds.minY + margin * 2) / SPOT_PITCH);
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const at = {
        x: Math.round((bounds.minX - margin + col * SPOT_PITCH) * 1e4) / 1e4,
        y: Math.round((bounds.minY - margin + row * SPOT_PITCH) * 1e4) / 1e4,
      };
      if (standable(at)) cells.push(at);
    }
  }

  /*
   * Share the cells out, rather than giving each department everything nearest to it.
   *
   * A nearest-centre partition looks obviously right and starves the middle of the office:
   * departments on the ends get the whole outside world, the ones hemmed in between get
   * slivers. Measured — fifty agents into Reading exhausted its share and the tail
   * collapsed onto neighbours' cells, five overlapping pairs at exactly zero distance.
   *
   * So departments take turns, each claiming its own nearest unclaimed cell. Everyone ends
   * up with a comparable share, still gathered around itself, and no cell is ever handed
   * out twice — which is the property that actually matters.
   */
  const byRoom = new Map<RoomId, World[]>();
  const ranked = new Map<RoomId, World[]>();
  for (const { room, at: centre } of centres) {
    byRoom.set(room, []);
    ranked.set(
      room,
      [...cells].sort((a, b) => {
        const da = Math.hypot(a.x - centre.x, a.y - centre.y);
        const db = Math.hypot(b.x - centre.x, b.y - centre.y);
        // Distance, then a stable tiebreak, so the order never depends on iteration order.
        return da - db || a.y - b.y || a.x - b.x;
      }),
    );
  }

  const taken = new Set<string>();
  const cursors = new Map<RoomId, number>(centres.map(({ room }) => [room, 0]));
  let handedOut = 0;
  while (handedOut < cells.length) {
    let progressed = false;
    for (const { room } of centres) {
      const order = ranked.get(room)!;
      let cursor = cursors.get(room)!;
      while (cursor < order.length && taken.has(`${order[cursor].x},${order[cursor].y}`)) {
        cursor += 1;
      }
      cursors.set(room, cursor);
      if (cursor >= order.length) continue;
      const cell = order[cursor];
      taken.add(`${cell.x},${cell.y}`);
      byRoom.get(room)!.push(cell);
      handedOut += 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  lattices.set(compiled.plan.id, byRoom);
  return byRoom;
}

export function overflowSpot(
  compiled: CompiledPlan,
  room: RoomId,
  index: number,
): World | null {
  const desks = desksOf(compiled, room);
  const spots = latticesFor(compiled).get(room) ?? [];
  if (spots.length === 0) return null;
  const overflow = Math.max(0, index - desks.length);
  if (overflow < spots.length) return spots[overflow];

  /*
   * Past the generated lattice, keep going rather than clamping.
   *
   * Clamping to the last spot was measured putting SEVENTEEN agents on one point — the
   * exact pile this module exists to prevent, moved to the end of the list. A crowd
   * standing beyond the drawn floor looks odd; a crowd drawn inside itself is a lie about
   * how many are working, and the office would be under-reporting its own load.
   *
   * So the tail spirals outward from the last spot on the same pitch. Deterministic from
   * the index, like everything else here.
   */
  const last = spots[spots.length - 1];
  const beyond = overflow - spots.length;
  const ring = Math.floor(beyond / 8) + 1;
  const step = beyond % 8;
  const angle = (step / 8) * Math.PI * 2;
  return {
    x: last.x + Math.cos(angle) * SPOT_PITCH * ring,
    y: last.y + Math.sin(angle) * SPOT_PITCH * ring,
  };
}

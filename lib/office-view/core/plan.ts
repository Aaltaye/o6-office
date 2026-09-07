/**
 * office-view/core/plan — floor-plan validation and compilation.
 *
 * A floor plan is authored as data (see `lib/floorplans/`). This module turns it into
 * the precomputed structures the renderer needs, and refuses plans that would produce a
 * wrong or unstable picture.
 *
 * Two decisions worth understanding:
 *
 * 1. **Depth bands are compiled once, not sorted per frame.** The obvious approach —
 *    re-sort SVG children by `x + y` every frame — is the actual performance cliff for
 *    SVG, because re-parenting invalidates the render tree. Instead we emit a fixed,
 *    ordered list of band containers here, and at runtime an actor is re-parented only
 *    when it *crosses* a band boundary. Motion within a band is a pure transform write.
 *
 * 2. **Paths are precomputed, so there is no runtime pathfinding.** The aisle graph is
 *    tiny (tens of nodes), so all-pairs shortest paths cost nothing to compute up front
 *    and remove a whole class of nondeterminism — two runs of the same event stream
 *    cannot pick different routes.
 *
 * Boundary rule: imports nothing but its own types.
 */

import type {
  AisleNodeId,
  CompiledBandKind,
  FloorPlan,
  RoomId,
  StationId,
  World,
} from './types.ts';

/**
 * Painter's-order depth for a world position under 2:1 dimetric projection.
 * Larger means nearer the viewer, so it paints later.
 */
export function depthOf(at: World): number {
  return at.x + at.y;
}

function distance(a: World, b: World): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * One paint layer. Actors live inside a band; the band's order in the array is its
 * paint order, so a worker in `station-seat` is drawn before — and therefore occluded
 * by — the same station's `station-front` polygon. That single trick carries most of
 * the isometric depth read.
 */
export type CompiledBand = {
  id: string;
  kind: CompiledBandKind;
  depth: number;
  stationId?: StationId;
};

export type CompiledPlan = {
  plan: FloorPlan;
  /** Paint order, ascending depth. Index into this is a band's z-order. */
  bands: CompiledBand[];
  /** Band index by id, so the renderer can re-parent without a scan. */
  bandIndex: Map<string, number>;
  /** The generic (non-station) bands an actor can occupy while walking. */
  aisleBands: CompiledBand[];
  /** Shortest route between any two aisle nodes, inclusive of both ends. */
  routes: Map<string, AisleNodeId[]>;
  /** Named world positions the scheduler animates between. */
  anchors: Map<string, World>;
  /** The stations each room owns, in plan order. Departments only. */
  roomStations: Map<RoomId, StationId[]>;
  /** Which room a station sits in, for the reverse lookup. */
  roomOf: Map<StationId, RoomId>;
  /** Non-fatal problems worth shouting about in development. */
  warnings: string[];
};

/** Stable key for the route table. */
function routeKey(from: AisleNodeId, to: AisleNodeId): string {
  return `${from}\u0000${to}`;
}

/**
 * Structural validation. Returns a list of problems; an empty list means the plan is
 * renderable. These are hard errors — a plan that fails them would render incorrectly,
 * not merely imperfectly.
 */
export function validateFloorPlan(plan: FloorPlan): string[] {
  const problems: string[] = [];

  const seen = <T>(items: readonly T[], key: (item: T) => string, what: string) => {
    const ids = new Set<string>();
    for (const item of items) {
      const id = key(item);
      if (ids.has(id)) problems.push(`duplicate ${what} id: ${id}`);
      ids.add(id);
    }
    return ids;
  };

  const roomIds = seen(plan.rooms, (r) => r.id, 'room');
  const stationIds = seen(plan.stations, (s) => s.id, 'station');
  const nodeIds = seen(plan.aisle.nodes, (n) => n.id, 'aisle node');
  seen(plan.doors, (d) => d.id, 'door');

  if (stationIds.size === 0) problems.push('plan has no stations');

  for (const station of plan.stations) {
    if (!roomIds.has(station.room)) {
      problems.push(`station "${station.id}" references unknown room "${station.room}"`);
    }
    if (!nodeIds.has(station.node)) {
      problems.push(`station "${station.id}" references unknown aisle node "${station.node}"`);
    }
  }

  for (const edge of plan.aisle.edges) {
    if (!nodeIds.has(edge.from)) problems.push(`aisle edge references unknown node "${edge.from}"`);
    if (!nodeIds.has(edge.to)) problems.push(`aisle edge references unknown node "${edge.to}"`);
    if (!(edge.lanes >= 1)) problems.push(`aisle edge ${edge.from}->${edge.to} needs at least 1 lane`);
  }

  if (!nodeIds.has(plan.inbox.node)) problems.push('inbox references an unknown aisle node');
  if (!nodeIds.has(plan.outbox.node)) problems.push('outbox references an unknown aisle node');

  // Specialists walk in through the entrance. Without exactly one, "someone arrives"
  // has nowhere to come from, or an ambiguous choice that would differ between runs.
  const entrances = plan.doors.filter((d) => d.entrance);
  if (entrances.length !== 1) {
    problems.push(`plan needs exactly one entrance door, found ${entrances.length}`);
  }

  if (plan.tile.w !== plan.tile.h * 2) {
    problems.push(
      `tile must be 2:1 dimetric (w === h * 2); got w=${plan.tile.w} h=${plan.tile.h}`,
    );
  }

  return problems;
}

/**
 * Non-fatal checks that catch occlusion bugs before they reach a screenshot.
 *
 * This is a heuristic guard, not a proof. It catches the two failure modes that have a
 * clear signature: an aisle edge whose endpoints share a depth (a walker moving along a
 * constant-depth line has an ambiguous band, which flickers), and an edge that passes
 * through a desk's seat tile (the walker would render through the furniture).
 */
function collectWarnings(plan: FloorPlan): string[] {
  const warnings: string[] = [];
  const nodeById = new Map(plan.aisle.nodes.map((n) => [n.id, n]));

  for (const edge of plan.aisle.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue; // already a hard error in validateFloorPlan

    if (depthOf(from.at) === depthOf(to.at)) {
      warnings.push(
        `aisle edge ${edge.from}->${edge.to} runs along a constant depth line; ` +
          'band assignment is ambiguous there and actors may flicker between layers',
      );
    }

    // Sample the segment and see whether it crosses a seat tile. Cheap because both the
    // station count and the sample count are tiny.
    for (const station of plan.stations) {
      for (let step = 1; step < 8; step++) {
        const t = step / 8;
        const point = {
          x: from.at.x + (to.at.x - from.at.x) * t,
          y: from.at.y + (to.at.y - from.at.y) * t,
        };
        if (distance(point, station.seat) < 0.5) {
          warnings.push(
            `aisle edge ${edge.from}->${edge.to} passes through the seat of station ` +
              `"${station.id}"; walkers will render through the desk`,
          );
          step = 8; // stop sampling this station
        }
      }
    }
  }

  return warnings;
}

/**
 * Build the ordered paint layers.
 *
 * Each station contributes three: `back` (far edge, monitor, partition), `seat` (where
 * a worker sits) and `front` (near edge, chair back) which paints over the seat. Aisle
 * bands fill the integer depths in between so a walking actor always has a layer.
 */
function buildBands(plan: FloorPlan): CompiledBand[] {
  const bands: CompiledBand[] = [];

  for (const station of plan.stations) {
    const depth = depthOf(station.seat);
    bands.push({ id: `${station.id}:back`, kind: 'station-back', depth: depth - 0.5, stationId: station.id });
    bands.push({ id: `${station.id}:seat`, kind: 'station-seat', depth, stationId: station.id });
    bands.push({ id: `${station.id}:front`, kind: 'station-front', depth: depth + 0.5, stationId: station.id });
  }

  // Aisle bands span the whole floor so an actor anywhere has somewhere to live.
  // Station positions are included deliberately: a walker approaching the deepest desk
  // would otherwise fall outside the band range and get clamped to the nearest one,
  // which paints it at the wrong depth.
  const positions: World[] = [
    ...plan.aisle.nodes.map((n) => n.at),
    ...plan.stations.flatMap((s) => [s.seat, s.inTray, s.outTray].filter((p) => p !== undefined)),
    plan.inbox.at,
    plan.outbox.at,
    ...plan.doors.map((d) => d.at),
  ];
  const depths = positions.map(depthOf);
  const min = Math.floor(Math.min(...depths));
  const max = Math.ceil(Math.max(...depths));
  for (let depth = min; depth <= max; depth++) {
    bands.push({ id: `aisle:${depth}`, kind: 'aisle', depth });
  }

  // Sort by depth, then by a fixed kind order, then by id. The tiebreakers matter: a
  // ties-broken-by-insertion sort would make paint order depend on authoring order,
  // which is exactly the kind of hidden nondeterminism that produces a bug you cannot
  // reproduce.
  const kindOrder: Record<CompiledBandKind, number> = {
    'station-back': 0,
    aisle: 1,
    'station-seat': 2,
    'station-front': 3,
  };
  bands.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return bands;
}

/**
 * All-pairs shortest paths over the aisle graph (Floyd–Warshall).
 *
 * The graph is tens of nodes, so the O(n^3) is irrelevant and we get every route
 * precomputed. Edges are treated as undirected: people walk both ways down a corridor.
 */
function buildRoutes(plan: FloorPlan): Map<string, AisleNodeId[]> {
  const nodes = plan.aisle.nodes;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const size = nodes.length;

  const dist: number[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => Infinity),
  );
  const next: (number | null)[][] = Array.from({ length: size }, () =>
    Array.from<number | null>({ length: size }).fill(null),
  );

  for (let i = 0; i < size; i++) {
    dist[i][i] = 0;
    next[i][i] = i;
  }

  for (const edge of plan.aisle.edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const weight = distance(nodes[a].at, nodes[b].at);
    // Keep the shorter edge if a plan declares a pair twice.
    if (weight < dist[a][b]) {
      dist[a][b] = weight;
      dist[b][a] = weight;
      next[a][b] = b;
      next[b][a] = a;
    }
  }

  for (let k = 0; k < size; k++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const viaK = dist[i][k] + dist[k][j];
        if (viaK < dist[i][j]) {
          dist[i][j] = viaK;
          next[i][j] = next[i][k];
        }
      }
    }
  }

  const routes = new Map<string, AisleNodeId[]>();
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (next[i][j] === null) continue;
      const path: AisleNodeId[] = [nodes[i].id];
      let at = i;
      while (at !== j) {
        const step = next[at][j];
        if (step === null) break;
        at = step;
        path.push(nodes[at].id);
      }
      routes.set(routeKey(nodes[i].id, nodes[j].id), path);
    }
  }

  return routes;
}

/**
 * Compile a validated plan into everything the renderer needs.
 *
 * Throws on structural problems rather than limping along: a plan with a dangling
 * station reference cannot be rendered honestly, and failing loudly at load is far
 * better than a desk that silently never appears.
 */
export function compileFloorPlan(plan: FloorPlan): CompiledPlan {
  const problems = validateFloorPlan(plan);
  if (problems.length > 0) {
    throw new Error(`Invalid floor plan "${plan.id}":\n  - ${problems.join('\n  - ')}`);
  }

  const bands = buildBands(plan);
  const bandIndex = new Map(bands.map((band, i) => [band.id, i]));

  const anchors = new Map<string, World>();
  anchors.set('inbox', plan.inbox.at);
  anchors.set('outbox', plan.outbox.at);
  for (const station of plan.stations) {
    anchors.set(`${station.id}:seat`, station.seat);
    // A satellite has no trays, so it contributes no tray anchors. Work is never routed
    // to one — only workers are.
    if (station.inTray) anchors.set(`${station.id}:in`, station.inTray);
    if (station.outTray) anchors.set(`${station.id}:out`, station.outTray);
  }
  for (const door of plan.doors) anchors.set(`door:${door.id}`, door.at);

  // Room indexes, built in the same pass as the anchors so a department can be located
  // and framed without any renderer re-deriving it.
  const roomStations = new Map<RoomId, StationId[]>();
  const roomOf = new Map<StationId, RoomId>();
  for (const room of plan.rooms) roomStations.set(room.id, []);
  for (const station of plan.stations) {
    if (!station.room) continue;
    roomOf.set(station.id, station.room);
    roomStations.get(station.room)?.push(station.id);
  }
  for (const room of plan.rooms) {
    const centre = {
      x: room.origin.x + room.size.w / 2,
      y: room.origin.y + room.size.h / 2,
    };
    anchors.set(`room:${room.id}`, centre);
  }

  return {
    plan,
    bands,
    bandIndex,
    aisleBands: bands.filter((b) => b.kind === 'aisle'),
    routes: buildRoutes(plan),
    anchors,
    roomStations,
    roomOf,
    warnings: collectWarnings(plan),
  };
}

/** Look up a precomputed route. Returns null when the graph is disconnected. */
export function routeBetween(
  compiled: CompiledPlan,
  from: AisleNodeId,
  to: AisleNodeId,
): AisleNodeId[] | null {
  return compiled.routes.get(routeKey(from, to)) ?? null;
}

/**
 * The band an actor at `at` should be parented to while walking.
 *
 * Picks the nearest aisle band by depth. Deterministic: on an exact tie it takes the
 * lower band, so two runs never disagree.
 */
export function aisleBandFor(compiled: CompiledPlan, at: World): CompiledBand {
  const depth = depthOf(at);
  let best = compiled.aisleBands[0];
  let bestDelta = Math.abs(best.depth - depth);
  for (const band of compiled.aisleBands) {
    const delta = Math.abs(band.depth - depth);
    if (delta < bestDelta) {
      best = band;
      bestDelta = delta;
    }
  }
  return best;
}

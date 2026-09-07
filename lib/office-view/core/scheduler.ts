/**
 * office-view/core/scheduler — turns an event stream into a timeline.
 *
 * Events are discrete and instantaneous. Animation takes time. Everything difficult
 * about this renderer lives in that gap, and the temptation at every step is to make the
 * picture prettier by making it slightly less true. This module exists to make that
 * impossible rather than merely discouraged, so the rules are compiled in as assertions
 * (`result.violations`) instead of written down in a README.
 *
 *   I1 — Order. For one entity, A's animation completes before B's begins. Enforced with
 *        per-entity cursors, not one global cursor: different entities overlap freely, an
 *        entity never overlaps itself.
 *
 *   I2 — No invention. Never play a transition without an event for it. If something's
 *        position changes with no journey to justify it, it CUTS. A cut is an honest
 *        ellipsis; a walk is a claim that a journey happened.
 *
 *   I3 — No reordering. Compression scales time. Aggregation may collapse *concurrent*
 *        events; it may never collapse *sequential* ones.
 *
 *   I4 — Visible compression. Whenever the rate is not 1 or items are batched, the UI
 *        says so. That converts a compromise into information instead of a lie.
 *
 *   I5 — Arrival is not occurrence. Scheduling orders by `occurredAt`, and genuinely
 *        simultaneous events are scheduled simultaneously into parallel lanes. Five
 *        parallel tool calls in one millisecond are concurrent; a FIFO queue would
 *        serialise them into an order that never happened.
 *
 * Nothing is ever dropped. The floor is a lossy view; the event log stays lossless and
 * the inspection panel shows everything.
 *
 * Boundary rule: imports only sibling core modules.
 */

import type { OfficeEvent, RoomId, StationId, WorkId, WorkerId, World } from './types.ts';
import { groupSimultaneous, jitterFor } from './events.ts';
import { type CompiledPlan, routeBetween } from './plan.ts';
import { claimDesk, deskOf, newClaims, overflowSpot, releaseWorker } from './seating.ts';
import { SPOT_PITCH } from './figure.ts';
import { workerOf } from './attribution.ts';
import { MotionChannel, StepChannel, type MotionTrack } from './timeline.ts';

export type SchedulerOptions = {
  /** Base time for a folder to travel one desk-to-desk trip, before compression. */
  walkMs: number;
  /** Floor under compression — below this, motion stops reading as motion. */
  minWalkMs: number;
  /** Time for a specialist to walk in from the door and sit. */
  arriveMs: number;
  /** Maximum deterministic stagger applied to simultaneous movers. */
  jitterMs: number;
  /**
   * Longest idle gap the timeline will reproduce. Real sessions contain minutes of
   * thinking; replaying those honestly would be unwatchable, so gaps are capped. This is
   * a compression, never a reordering, and it is surfaced under I4.
   */
  maxGapMs: number;
  /** Debt below which everything plays at full length (tier 1). */
  tier1DebtMs: number;
  /** Debt above which the floor summarises rather than animating individually (tier 3). */
  tier2DebtMs: number;
  /** Ceiling on playback rate under compression. */
  maxRate: number;
  /** Concurrent items in transit before they collapse into one cart with a count. */
  aggregateAbove: number;
  /** Swap easings to a hard cut and collapse durations. Truthful, just motionless. */
  reducedMotion: boolean;
};

export const DEFAULT_OPTIONS: SchedulerOptions = {
  walkMs: 1200,
  minWalkMs: 350,
  arriveMs: 1600,
  jitterMs: 220,
  maxGapMs: 1400,
  tier1DebtMs: 1500,
  tier2DebtMs: 6000,
  maxRate: 3,
  aggregateAbove: 4,
  reducedMotion: false,
};

/** A person on the floor — a permanent desk worker or a visiting specialist. */
export type WorkerState = {
  id: WorkerId;
  role: string;
  kind: 'permanent' | 'specialist';
  /** The specialist's literal assignment, when the producer supplied one. Never invented. */
  assignment?: string;
  motion: MotionChannel;
  /** What this person is doing, in plain language. Null when idle — this drives the
   *  violet highlight, and violet may only ever mean 'happening right now'. */
  status: StepChannel<string | null>;
  /** Present on the floor between joining and leaving. */
  present: StepChannel<boolean>;
  /**
   * Which desk this person is at, at any moment, or null when they hold none.
   *
   * A channel rather than a scalar because "who is in this department right now" is a
   * question about an instant, and a field mutated during scheduling can only answer
   * "where did they end up". Sampled like every other fact on the floor.
   */
  stationAt: StepChannel<StationId | null>;
  /**
   * Which DEPARTMENT they are in, which is not always the same question as which desk.
   *
   * An agent whose department has no free desk stands in it rather than being dropped, so
   * it has a room but no station. Without this channel the office would report them as
   * being nowhere while drawing them plainly inside Operations.
   */
  roomAt: StepChannel<RoomId | null>;
  /**
   * Final desk. Scheduler bookkeeping only (hot-desk release and occupancy); it is NOT
   * time-aware, so never read it to decide where somebody is at time t.
   */
  station?: StationId;
};

/** One unit of work — a lead, a file, a prompt. Rendered as a folder. */
export type WorkState = {
  id: WorkId;
  label: string;
  motion: MotionChannel;
  /** Which desk holds it. */
  holder: StepChannel<StationId | 'inbox' | 'outbox'>;
  /** Collapsed into a cart with others when the floor is busy. */
  batched: StepChannel<boolean>;
  outcome?: 'done' | 'held' | 'excluded';
};

export type ScheduleResult = {
  workers: Map<WorkerId, WorkerState>;
  work: Map<WorkId, WorkState>;
  /** Assignment activity per desk, for the "this desk is busy" light pool. */
  stationBusy: Map<StationId, StepChannel<string | null>>;
  outboxCount: StepChannel<number>;
  /**
   * I4: what the viewer must be told about how time is being handled, at each moment.
   *
   * `skippedMs` is cumulative real time that was never shown — dead air truncated to
   * `maxGapMs`. It is the compression that fires most often in a real session, and it is
   * invisible unless something says it out loud.
   */
  compression: StepChannel<{ rate: number; batched: number; skippedMs: number }>;
  /** Maps each event id to the sim time it was scheduled at, for the activity trail. */
  timeOf: Map<string, number>;
  duration: number;
  /** Invariant breaches. Non-empty means a bug — surfaced loudly in development. */
  violations: string[];
};

/** World position for a named anchor, falling back to the inbox if a plan lacks it. */
function anchor(plan: CompiledPlan, key: string): World {
  return plan.anchors.get(key) ?? plan.plan.inbox.at;
}

/** Aisle waypoints between two stations, so a folder follows the corridor. */
function waypointsBetween(
  plan: CompiledPlan,
  from: StationId | 'inbox' | 'outbox',
  to: StationId | 'inbox' | 'outbox',
): World[] {
  const nodeOf = (id: string): string | null => {
    if (id === 'inbox') return plan.plan.inbox.node;
    if (id === 'outbox') return plan.plan.outbox.node;
    return plan.plan.stations.find((s) => s.id === id)?.node ?? null;
  };
  const fromNode = nodeOf(from);
  const toNode = nodeOf(to);
  if (!fromNode || !toNode) return [];
  const route = routeBetween(plan, fromNode, toNode);
  if (!route) return [];
  const byId = new Map(plan.plan.aisle.nodes.map((n) => [n.id, n.at]));
  return route.map((id) => byId.get(id)).filter((at): at is World => Boolean(at));
}

/** How far apart, in tile units, folders travelling together are nudged. */
const LANE_SPACING = 0.32;

/**
 * Offset a route sideways so items travelling together do not overlap exactly.
 *
 * Without this, several folders moving at once merge into one smeared violet bar and the
 * viewer cannot tell whether they are watching one thing or six. The offset is
 * perpendicular to the route's overall direction and keyed by position within the
 * simultaneity group, so it is deterministic — a replay lays out the same lanes as the
 * live run did.
 *
 * Endpoints are left untouched: work arrives at the tray, not beside it.
 */
function laneOffsetPath(path: World[], lane: number, lanes: number): World[] {
  if (path.length < 2 || lanes <= 1) return path;

  const start = path[0];
  const end = path[path.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return path;

  // Perpendicular unit vector, centred so the group straddles the corridor's middle.
  const nx = -dy / length;
  const ny = dx / length;
  const offset = (lane - (lanes - 1) / 2) * LANE_SPACING;

  return path.map((point, index) =>
    index === 0 || index === path.length - 1
      ? point
      : { x: point.x + nx * offset, y: point.y + ny * offset },
  );
}

/** Where a piece of work physically sits when a station holds it. */
function holdingPoint(plan: CompiledPlan, holder: StationId | 'inbox' | 'outbox'): World {
  if (holder === 'inbox') return plan.plan.inbox.at;
  if (holder === 'outbox') return plan.plan.outbox.at;
  return anchor(plan, `${holder}:in`);
}

/**
 * Compile an event stream into a timeline.
 *
 * Pure: same events plus same plan always yields the same timeline, which is what makes
 * a replay pixel-identical to the live run it came from.
 */
export function schedule(
  events: readonly OfficeEvent[],
  plan: CompiledPlan,
  options: Partial<SchedulerOptions> = {},
): ScheduleResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const groups = groupSimultaneous(events);

  const workers = new Map<WorkerId, WorkerState>();
  const work = new Map<WorkId, WorkState>();
  const stationBusy = new Map<StationId, StepChannel<string | null>>();
  const outboxCount = new StepChannel<number>();
  const compression = new StepChannel<{ rate: number; batched: number; skippedMs: number }>();
  const timeOf = new Map<string, number>();
  const violations: string[] = [];

  /** I1: when each entity is next free. An entity never overlaps itself. */
  const freeAt = new Map<string, number>();
  /** Where each entity currently is, so a track can start from the truth. */
  const positionOf = new Map<string, World>();
  /** Hot desks currently taken, so an unknown-role specialist gets a free one. */
  const hotDeskTaken = new Map<StationId, WorkerId>();

  let timelineHead = 0;
  let simTime = 0;
  let lastOccurred: number | null = null;
  let outbox = 0;
  let lastReportedRate = 1;
  /** Cumulative real milliseconds truncated out of idle gaps, for I4. */
  let skippedMs = 0;
  let lastReportedSkippedSec = 0;
  let lastReportedBatched = 0;

  const hotDesks = plan.plan.stations.filter((s) => s.hotDesk);

  const staffing = plan.plan.staffing ?? 'permanent';

  // A `permanent` plan describes a standing team, so every non-hot desk is staffed for
  // the whole run: the workflow really does have six roles, and "six desks, six people"
  // is the metaphor the viewer arrives with. They are seated from the start and never
  // move — only specialists come and go.
  //
  // A `dynamic` plan assumes nobody. Workers appear when the stream first shows them
  // working and walk to whichever desk their current assignment is at. That is the only
  // honest option for a live session, where the cast is whatever is actually running.
  if (staffing === 'permanent') {
    for (const station of plan.plan.stations) {
      if (station.hotDesk) continue;
      const worker: WorkerState = {
        id: `desk:${station.id}`,
        role: station.role,
        kind: 'permanent',
        motion: new MotionChannel([
          { startMs: 0, endMs: 0, from: station.seat, to: station.seat, ease: 'stepEnd' },
        ]),
        status: new StepChannel<string | null>(),
        present: new StepChannel<boolean>(),
        stationAt: new StepChannel<StationId | null>(),
        roomAt: new StepChannel<RoomId | null>(),
        station: station.id,
      };
      worker.present.push(0, true);
      worker.status.push(0, null);
      worker.stationAt.push(0, station.id);
      workers.set(worker.id, worker);
      positionOf.set(`worker:${worker.id}`, station.seat);
    }
  }

  /**
   * Who holds which desk.
   *
   * Replaces a per-station headcount that only ever went up unless a worker changed
   * department, and a 0.55-unit fan-out that placed the second person at a desk inside the
   * first one. Desks are handed out and handed back; see core/seating.ts for the rules.
   */
  const claims = newClaims();

  /**
   * Where somebody stands while they have no assignment at all.
   *
   * The lounge is not a department and has no desks, so spots are handed out by arrival
   * order and handed back on departure — the same free-or-not rule, without furniture.
   */
  const waitingSpots: (WorkerId | null)[] = [];
  const claimWaitingSpot = (worker: WorkerId): number => {
    const existing = waitingSpots.indexOf(worker);
    if (existing !== -1) return existing;
    const free = waitingSpots.indexOf(null);
    if (free !== -1) {
      waitingSpots[free] = worker;
      return free;
    }
    return waitingSpots.push(worker) - 1;
  };
  const releaseWaitingSpot = (worker: WorkerId) => {
    const at = waitingSpots.indexOf(worker);
    // A hole, never a splice: renumbering would move people who have not moved.
    if (at !== -1) waitingSpots[at] = null;
  };

  /**
   * Fan positions out around a point, far enough apart that two figures never intersect.
   *
   * The spacing comes from core/figure.ts rather than a literal. Its predecessor used 0.55
   * against a figure 0.80 wide, which is why several agents at one spot were drawn inside
   * one another.
   */
  const spread = (base: World, index: number): World => {
    if (index === 0) return base;
    const ring = Math.ceil(index / 6);
    const angle = ((index % 6) / 6) * Math.PI * 2;
    return {
      x: base.x + Math.cos(angle) * SPOT_PITCH * ring,
      y: base.y + Math.sin(angle) * SPOT_PITCH * ring,
    };
  };

  /**
   * Find or create a worker in a dynamic office.
   *
   * The main agent has no `worker` on its events, so it gets one synthetic identity —
   * there is exactly one of it, and it is genuinely present for the whole session.
   */
  const ensureWorker = (id: string | undefined, at: number): WorkerState | null => {
    if (staffing !== 'dynamic') return id ? (workers.get(id) ?? null) : null;
    const workerId = id ?? 'main';
    let worker = workers.get(workerId);
    if (!worker) {
      worker = {
        id: workerId,
        role: workerId === 'main' ? 'Agent' : 'Subagent',
        kind: workerId === 'main' ? 'permanent' : 'specialist',
        motion: new MotionChannel(),
        status: new StepChannel<string | null>(),
        present: new StepChannel<boolean>(),
        stationAt: new StepChannel<StationId | null>(),
        roomAt: new StepChannel<RoomId | null>(),
      };
      worker.present.push(at, true);
      worker.status.push(at, null);
      // They exist and are on the floor, but hold no desk until work sends them to one.
      worker.stationAt.push(at, null);
      workers.set(workerId, worker);
      const entrance = plan.plan.doors.find((d) => d.entrance) ?? plan.plan.doors[0];
      positionOf.set(`worker:${workerId}`, entrance ? entrance.at : plan.plan.inbox.at);
    }
    return worker;
  };

  /**
   * Mirror a desk's current activity onto whoever is sitting there.
   *
   * Extends the timeline to cover the change. A desk going quiet is scheduled slightly
   * after the work leaves it, and without this the run could end *before* that — leaving
   * the last desk lit violet forever, which would claim work was still in progress.
   */
  const setDeskStatus = (station: StationId, at: number, label: string | null) => {
    workers.get(`desk:${station}`)?.status.push(at, label);
    timelineHead = Math.max(timelineHead, at);
  };

  const busyChannel = (station: StationId) => {
    let channel = stationBusy.get(station);
    if (!channel) {
      channel = new StepChannel<string | null>();
      channel.push(0, null);
      stationBusy.set(station, channel);
    }
    return channel;
  };

  const ensureWork = (id: WorkId, label: string, at: number): WorkState => {
    let state = work.get(id);
    if (!state) {
      state = {
        id,
        label,
        motion: new MotionChannel(),
        holder: new StepChannel<StationId | 'inbox' | 'outbox'>(),
        batched: new StepChannel<boolean>(),
      };
      state.holder.push(at, 'inbox');
      state.batched.push(at, false);
      positionOf.set(`work:${id}`, plan.plan.inbox.at);
      work.set(id, state);
    }
    return state;
  };

  /** I4: only record a change, so the channel stays small and the UI only reacts on change. */
  const noteCompression = (at: number, rate: number, batched: number) => {
    // Skipped time only needs restating when it has moved by a whole second; otherwise a
    // long session would push an entry per event and the channel would balloon.
    const skippedSec = Math.floor(skippedMs / 1000);
    if (
      rate === lastReportedRate &&
      batched === lastReportedBatched &&
      skippedSec === lastReportedSkippedSec
    ) {
      return;
    }
    compression.push(at, { rate, batched, skippedMs });
    lastReportedRate = rate;
    lastReportedBatched = batched;
    lastReportedSkippedSec = skippedSec;
  };

  for (const group of groups) {
    const occurredAt = group[0].occurredAt;

    // Advance sim time by the real gap, capped. Capping compresses dead air; it never
    // reorders anything, and the cap being hit is reported under I4.
    if (lastOccurred === null) {
      simTime = 0;
    } else {
      const realGap = occurredAt - lastOccurred;
      // What the viewer does NOT get to see. Reported under I4 rather than swallowed.
      skippedMs += Math.max(0, realGap - opts.maxGapMs);
      simTime += Math.min(realGap, opts.maxGapMs);
    }
    lastOccurred = occurredAt;

    // Tiering by scheduled-time debt: how far the timeline has run ahead of the events
    // feeding it. Length, not queue depth, is the thing that actually hurts.
    const debt = Math.max(0, timelineHead - simTime);
    const rate =
      debt < opts.tier1DebtMs
        ? 1
        : Math.min(Math.max(1, debt / opts.tier1DebtMs), opts.maxRate);
    const summarising = debt >= opts.tier2DebtMs;
    // Compress uniformly, so relative ordering and relative durations both survive.
    const scale = opts.reducedMotion ? 0 : 1 / rate;
    const walkMs = opts.reducedMotion
      ? 0
      : Math.max(opts.minWalkMs, opts.walkMs * scale);
    const arriveMs = opts.reducedMotion ? 0 : Math.max(opts.minWalkMs, opts.arriveMs * scale);

    // Concurrency at this instant is simply how many handoffs share this group — they
    // are, by definition, simultaneous. The previous approach used a counter mutated
    // inside the loop, which could never exceed one and so silently disabled batching.
    const concurrentHandoffs = group.filter((event) => event.type === 'handoff').length;
    let handoffIndex = 0;

    for (const event of group) {
      // I5: every event in this group shares one sim time. They are concurrent, so they
      // are scheduled concurrently — the only serialisation is per entity, via freeAt.
      const jitter = opts.reducedMotion ? 0 : jitterFor(event.id, opts.jitterMs);
      timeOf.set(event.id, simTime);

      const startFor = (entityKey: string) => {
        const free = freeAt.get(entityKey) ?? -Infinity;
        // I1: never start before this entity finished its previous action.
        return Math.max(simTime + jitter, free);
      };

      const moveEntity = (
        entityKey: string,
        channel: MotionChannel,
        to: World,
        durationMs: number,
        via?: World[],
      ) => {
        const from = positionOf.get(entityKey) ?? to;
        const start = startFor(entityKey);
        const track: MotionTrack = {
          startMs: start,
          endMs: start + durationMs,
          from,
          to,
          via,
          // I2: with no duration this is a cut, not a fabricated journey.
          ease: durationMs <= 0 ? 'stepEnd' : 'easeInOut',
        };
        if (channel.busyUntil > start) {
          violations.push(
            `I1 violated: ${entityKey} scheduled at ${start} while busy until ${channel.busyUntil}`,
          );
        }
        channel.push(track);
        positionOf.set(entityKey, to);
        freeAt.set(entityKey, track.endMs);
        timelineHead = Math.max(timelineHead, track.endMs);
      };

      switch (event.type) {
        case 'work.received': {
          const state = ensureWork(event.work.id, event.work.label, simTime);
          state.holder.push(simTime, 'inbox');
          break;
        }

        case 'handoff': {
          const state = ensureWork(event.work.id, event.work.label, simTime);
          const key = `work:${event.work.id}`;
          const lane = handoffIndex++;

          // Tier 3, or too many folders abreast: collapse into a cart with a count. This
          // is the mechanism that protects the art direction under load. Only ever
          // applied to items in transit *at the same time* — never to a sequence (I3).
          const collapse = summarising || concurrentHandoffs > opts.aggregateAbove;
          state.batched.push(simTime, collapse);

          // Lane assignment. Folders travelling together are nudged sideways so they
          // read as several things moving, not one smeared object. Keyed by position
          // within the group rather than by arrival, so a replay lays them out
          // identically to the live run.
          const via = laneOffsetPath(
            waypointsBetween(plan, event.from, event.to),
            lane,
            concurrentHandoffs,
          );
          const destination = holdingPoint(plan, event.to);
          // A backward handoff is the flagship beat, so it is given room to read: the
          // reviewer walks it back deliberately rather than snapping.
          const duration = event.direction === 'backward' ? walkMs * 1.35 : walkMs;
          moveEntity(key, state.motion, destination, duration, via);
          state.holder.push(freeAt.get(key) ?? simTime, event.to);

          if (event.to === 'outbox') {
            outbox += 1;
            outboxCount.push(freeAt.get(key) ?? simTime, outbox);
          }
          break;
        }

        case 'assignment.started': {
          const worker = ensureWorker(event.worker, simTime);

          /*
           * The event names a department; the agent takes one of that department's desks.
           * Which desk lights up is therefore the one they actually sat at, not the one the
           * producer named — a producer knows what kind of work it is doing and has no
           * business knowing how many desks we drew.
           */
          let lit: StationId = event.station;

          if (staffing === 'dynamic' && worker) {
            const claim = claimDesk(claims, plan, event.station, worker.id);
            if (claim) {
              if (claim.deskId) lit = claim.deskId;
              const wasAtDesk = worker.stationAt.sampleAt(simTime);
              const wasInRoom = worker.roomAt.sampleAt(simTime);
              const spot = claim.deskId
                ? plan.plan.stations.find((s) => s.id === claim.deskId)?.seat
                : overflowSpot(plan, claim.room, claim.index);

              worker.roomAt.push(simTime, claim.room);
              worker.stationAt.push(simTime, claim.deskId);
              worker.station = claim.deskId ?? undefined;

              /*
               * Only walk them if this is genuinely a different place — re-deriving a route
               * for an agent already at its desk would animate a journey that never was.
               *
               * The room has to be part of that comparison, not just the desk. An agent
               * standing in a full department holds NO desk, so comparing desks alone made
               * "waiting by the door with no desk" look identical to "standing in
               * Operations with no desk", and the overflow agents never left the lounge
               * while the office cheerfully reported them as being in Operations.
               */
              if (spot && (wasAtDesk !== claim.deskId || wasInRoom !== claim.room)) {
                moveEntity(`worker:${worker.id}`, worker.motion, spot, walkMs);
              }
            }
          }

          busyChannel(lit).push(simTime, event.label);
          setDeskStatus(lit, simTime, event.label);
          if (worker) worker.status.push(simTime, event.label);
          break;
        }

        case 'assignment.finished': {
          /*
           * Quieten the desk the agent actually sat at, and the agent with it.
           *
           * The worker half is new. status was pushed a label when work started and nothing
           * ever pushed it back, so an agent read as running its last tool forever — which
           * only stayed invisible because a departed worker stops being drawn. It is the
           * same rule the desks already follow: violet means right now, so it has to stop.
           */
          const seated = workerOf(event);
          const lit = seated ? (deskOf(claims, plan, seated) ?? event.station) : event.station;
          busyChannel(lit).push(simTime + walkMs, null);
          setDeskStatus(lit, simTime + walkMs, null);
          if (seated) {
            workers.get(seated)?.status.push(simTime + walkMs, null);
            timelineHead = Math.max(timelineHead, simTime + walkMs);
          }
          break;
        }

        case 'assignment.failed': {
          // The reason is the producer's own words. We render it verbatim rather than
          // paraphrasing, so the office never asserts something the run did not.
          busyChannel(event.station).push(simTime, event.reason);
          setDeskStatus(event.station, simTime, event.reason);
          break;
        }

        case 'specialist.joined': {
          // Pick the lowest free hot desk, by plan order. Deterministic, so replay puts
          // the same specialist at the same desk as the live run did.
          // Explicit rather than `event.station && find(...)`, which would evaluate to
          // the empty string if a producer ever sent one.
          const named = event.station
            ? plan.plan.stations.find((s) => s.id === event.station)
            : undefined;
          const desk = named ?? hotDesks.find((s) => !hotDeskTaken.has(s.id));
          const key = `worker:${event.worker}`;
          const entrance = plan.plan.doors.find((d) => d.entrance) ?? plan.plan.doors[0];

          // Reuse the worker if the stream already showed them working — a subagent can
          // produce a tool call before its SubagentStart is delivered.
          const state =
            (staffing === 'dynamic' ? ensureWorker(event.worker, simTime) : null) ??
            workers.get(event.worker) ??
            ({
              id: event.worker,
              role: event.role,
              kind: 'specialist',
              motion: new MotionChannel(),
              status: new StepChannel<string | null>(),
              present: new StepChannel<boolean>(),
              stationAt: new StepChannel<StationId | null>(),
              roomAt: new StepChannel<RoomId | null>(),
            } as WorkerState);

          state.role = event.role;
          state.kind = 'specialist';
          // Their own stated assignment, when the producer supplied one. Never invented.
          state.assignment = event.detail;
          state.present.push(simTime, true);
          state.status.push(simTime, event.label);
          workers.set(event.worker, state);
          if (!positionOf.has(key)) {
            positionOf.set(key, entrance ? entrance.at : plan.plan.inbox.at);
          }

          if (staffing === 'dynamic') {
            // No desk is claimed. They walk in, wait near the door, and go wherever
            // their first assignment is. Capacity is never the reason someone is missing
            // from a live office — if six subagents are running, six are on the floor.
            /*
             * Where they stand while they have no assignment. A plan may declare a room
             * for this; otherwise they wait just inside the door. Either way the spot is
             * a ring that grows, so there is still no capacity — twenty subagents all
             * stand somewhere rather than nineteen standing and one being dropped.
             */
            const lounge = plan.plan.rooms.find((room) => room.kind === 'waiting');
            const base = lounge
              ? { x: lounge.origin.x + lounge.size.w / 2, y: lounge.origin.y + lounge.size.h / 2 }
              : entrance
                ? { x: entrance.at.x, y: entrance.at.y + 1 }
                : plan.plan.inbox.at;
            /*
             * Queued through the same allocator the departments use, so an arrival takes
             * the lowest free spot and gives it back on leaving. The old counter was keyed
             * by the literal string 'door' and never decremented at all, so in a long
             * session each new subagent waited further from the door than the last.
             */
            const waitingIndex = claimWaitingSpot(event.worker);
            const waiting = spread(base, waitingIndex);
            state.station = undefined;
            state.stationAt.push(simTime, null);
            state.roomAt.push(simTime, lounge ? lounge.id : null);
            moveEntity(key, state.motion, waiting, arriveMs);
          } else if (desk) {
            // Permanent plans have a modelled pool: take the lowest free hot desk, by
            // plan order, so a replay seats the same specialist at the same desk.
            state.station = desk.id;
            state.stationAt.push(simTime, desk.id);
            hotDeskTaken.set(desk.id, event.worker);
            moveEntity(key, state.motion, desk.seat, arriveMs);
          } else {
            // Pool exhausted: the specialist stands at the edge rather than the plan
            // growing new desks at runtime, which would break determinism and the art.
            state.station = undefined;
            state.stationAt.push(simTime, null);
          }
          break;
        }

        case 'specialist.left': {
          const state = workers.get(event.worker);
          if (!state) break;
          const key = `worker:${event.worker}`;
          const entrance = plan.plan.doors.find((d) => d.entrance) ?? plan.plan.doors[0];
          if (entrance) moveEntity(key, state.motion, entrance.at, arriveMs);
          state.present.push(freeAt.get(key) ?? simTime, false);
          // They hold no desk from the moment they head for the door; the scalar below is
          // only kept so the hot desk can be released.
          state.stationAt.push(simTime, null);
          state.roomAt.push(simTime, null);
          /*
           * And they stop working. status was never cleared here, so a departed agent's
           * last tool label stayed on its channel for the rest of the run — invisible only
           * because nothing draws a worker that is not present. Violet means right now, and
           * an agent walking out of the door is not doing anything right now.
           */
          state.status.push(simTime, null);
          // Give the desk and the waiting spot back, so the next arrival can have them.
          releaseWorker(claims, event.worker);
          releaseWaitingSpot(event.worker);
          if (state.station) hotDeskTaken.delete(state.station);
          /*
           * `station` is deliberately NOT cleared. It is end-of-run bookkeeping — the desk
           * this worker was last assigned — and both the hot-desk tests read it as exactly
           * that record. Where somebody is at time t is `stationAt`, which was just pushed
           * null above.
           */
          break;
        }

        case 'artifact.created': {
          // Show it, then go quiet. An artifact is an instant, not an ongoing activity,
          // so leaving the desk lit would keep claiming work is in progress there long
          // after it finished — and violet is only ever allowed to mean "right now".
          busyChannel(event.station).push(simTime, event.label);
          setDeskStatus(event.station, simTime, event.label);
          busyChannel(event.station).push(simTime + walkMs, null);
          setDeskStatus(event.station, simTime + walkMs, null);
          break;
        }

        case 'review.requested': {
          busyChannel(event.station).push(simTime, event.question);
          setDeskStatus(event.station, simTime, event.question);
          break;
        }

        case 'blocked': {
          busyChannel(event.station).push(simTime, `Waiting for ${event.waitingOn}`);
          setDeskStatus(event.station, simTime, `Waiting for ${event.waitingOn}`);
          break;
        }

        case 'run.finished': {
          /*
           * The run is over, so nothing is in progress any more.
           *
           * This exists because a desk lit by `assignment.started` with no matching
           * `assignment.finished` — an interrupted tool call, a crash, a session closed
           * mid-work — otherwise stays lit for the rest of the run, with the office
           * claiming work is still happening at it.
           *
           * Note carefully what this does NOT say. It pushes `null`, which means "not
           * happening now" — it does not mark the assignment finished, successful, or
           * failed, because the run ending tells us none of those things. The event trail
           * still shows the assignment starting and never finishing, which is the truth.
           */
          for (const station of stationBusy.keys()) {
            if (busyChannel(station).sampleAt(simTime) === null) continue;
            busyChannel(station).push(simTime, null);
            setDeskStatus(station, simTime, null);
          }
          break;
        }

        default:
          // run.started, review.resolved, usage.reported and note have no floor
          // consequence. They still reach the activity trail and the panel — the floor is
          // the lossy view, the log is not.
          break;
      }
    }

    noteCompression(
      simTime,
      Math.round(rate * 10) / 10,
      // Report the batch size only when items were actually collapsed (I4).
      concurrentHandoffs > opts.aggregateAbove || (summarising && concurrentHandoffs > 1)
        ? concurrentHandoffs
        : 0,
    );
  }

  return {
    workers,
    work,
    stationBusy,
    outboxCount,
    compression,
    timeOf,
    duration: Math.max(timelineHead, simTime),
    violations,
  };
}

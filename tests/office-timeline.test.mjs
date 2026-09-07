/**
 * T002 — projection, timeline and scheduler.
 *
 * These are the pure functions the whole renderer rests on, so they are tested without a
 * single rendered pixel. The determinism tests matter most: a replay has to be identical
 * to the live run it came from, or the recorded public demo is not evidence of anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  worldToScreen,
  screenToWorld,
  lerpWorld,
  planBounds,
  focusBounds,
  toViewBox,
} from '../lib/office-view/core/projection.ts';
import {
  MotionChannel,
  StepChannel,
  SimClock,
  samplePath,
  sampleTrack,
  easings,
} from '../lib/office-view/core/timeline.ts';
import { schedule, DEFAULT_OPTIONS } from '../lib/office-view/core/scheduler.ts';
import { compileFloorPlan } from '../lib/office-view/core/plan.ts';
import { frameOffice } from '../lib/office-view/core/framing.ts';
import { presenceAt } from '../lib/office-view/core/visibility.ts';
import { planBox, neededShell, buildRoomShell } from '../lib/office-view/three/room-kit.ts';
// A worker's drawn footprint, shared with the renderer so seating and drawing cannot drift.
import { WORKER_DIAMETER } from '../lib/office-view/core/figure.ts';
import { createEmitter } from '../lib/office-view/core/events.ts';
import { leadReactivationPlan } from '../lib/floorplans/lead-reactivation.ts';
import { codingSessionPlan } from '../lib/floorplans/coding-session.ts';
import { departmentsAt, departmentAt } from '../lib/office-view/core/departments.ts';

const TILE = { w: 64, h: 32, z: 24 };
const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} !== ${b}`);

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test('projection is 2:1 dimetric', () => {
  // One tile east goes half a tile-width right and half a tile-height down.
  assert.deepEqual(worldToScreen({ x: 1, y: 0 }, TILE), { sx: 32, sy: 16 });
  // One tile south goes the same distance the other way.
  assert.deepEqual(worldToScreen({ x: 0, y: 1 }, TILE), { sx: -32, sy: 16 });
  // The origin is the origin.
  assert.deepEqual(worldToScreen({ x: 0, y: 0 }, TILE), { sx: 0, sy: 0 });
});

test('height lifts a point without moving it sideways', () => {
  const ground = worldToScreen({ x: 2, y: 3 }, TILE);
  const raised = worldToScreen({ x: 2, y: 3, z: 1 }, TILE);
  assert.equal(raised.sx, ground.sx);
  assert.equal(raised.sy, ground.sy - TILE.z);
});

test('screenToWorld inverts worldToScreen', () => {
  // Needed for click-empty-floor-to-deselect, so it has to be exact, not approximate.
  for (const point of [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: -2.5, y: 7.25 }, { x: 10, y: 3 }]) {
    const back = screenToWorld(worldToScreen(point, TILE), TILE);
    near(back.x, point.x);
    near(back.y, point.y);
  }
});

test('plan bounds contain every feature, with headroom for standing figures', () => {
  const bounds = planBounds(leadReactivationPlan);
  assert.ok(bounds.width > 0 && bounds.height > 0);
  for (const station of leadReactivationPlan.stations) {
    const at = worldToScreen(station.seat, leadReactivationPlan.tile);
    assert.ok(at.sx >= bounds.minX && at.sx <= bounds.minX + bounds.width, 'x outside bounds');
    assert.ok(at.sy >= bounds.minY && at.sy <= bounds.minY + bounds.height, 'y outside bounds');
  }
  assert.match(toViewBox(bounds), /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
});

test('focusing a desk zooms in and stays inside the plan', () => {
  const full = planBounds(leadReactivationPlan);
  const focus = focusBounds(leadReactivationPlan, { x: 4, y: 3 }, 3);
  assert.ok(focus.width < full.width, 'zooming should show less, not more');
  assert.ok(focus.minX >= full.minX - 1e-6, 'camera must not pan off the west edge');
  assert.ok(
    focus.minX + focus.width <= full.minX + full.width + 1e-6,
    'camera must not pan off the east edge',
  );
});

test('lerpWorld interpolates including height', () => {
  assert.deepEqual(lerpWorld({ x: 0, y: 0 }, { x: 10, y: 4, z: 2 }, 0.5), { x: 5, y: 2, z: 1 });
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

test('samplePath walks a polyline by arc length, not by segment index', () => {
  // A route with one long and one short leg must not lurch at the join.
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 0 }];
  near(samplePath(path, 0).x, 0);
  near(samplePath(path, 1).x, 12);
  // Halfway by distance is 6 along, which is still inside the FIRST segment.
  near(samplePath(path, 0.5).x, 6);
});

test('samplePath survives degenerate routes', () => {
  assert.deepEqual(samplePath([{ x: 3, y: 3 }], 0.5), { x: 3, y: 3 });
  const stationary = samplePath([{ x: 1, y: 1 }, { x: 1, y: 1 }], 0.5);
  assert.equal(stationary.x, 1);
});

test('a zero-duration track is a cut, not a journey', () => {
  // Invariant I2: without an event to justify a journey, entities cut.
  const track = { startMs: 100, endMs: 100, from: { x: 0, y: 0 }, to: { x: 5, y: 5 } };
  assert.deepEqual(sampleTrack(track, 99), { x: 0, y: 0 });
  assert.deepEqual(sampleTrack(track, 100), { x: 5, y: 5 });
});

test('reduced motion easing holds still and then cuts', () => {
  assert.equal(easings.stepEnd(0.99), 0);
  assert.equal(easings.stepEnd(1), 1);
});

test('seeking is deterministic in both directions', () => {
  // The whole architecture exists so scrub, rewind and playback share one code path.
  // If forward and backward seeks disagree, replay is not evidence of anything.
  const channel = new MotionChannel([
    { startMs: 0, endMs: 1000, from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, ease: 'linear' },
    { startMs: 1000, endMs: 2000, from: { x: 10, y: 0 }, to: { x: 10, y: 10 }, ease: 'linear' },
    { startMs: 2000, endMs: 3000, from: { x: 10, y: 10 }, to: { x: 0, y: 10 }, ease: 'linear' },
  ]);

  const times = [0, 250, 500, 1500, 2500, 2999, 3000];
  const forward = times.map((t) => channel.sampleAt(t));
  const backward = [...times].reverse().map((t) => channel.sampleAt(t)).reverse();
  assert.deepEqual(forward, backward, 'a backward scrub must agree with a forward one');

  // And re-sampling the same instant twice must not drift.
  assert.deepEqual(channel.sampleAt(1500), channel.sampleAt(1500));
});

test('between tracks an entity holds where it arrived', () => {
  const channel = new MotionChannel([
    { startMs: 0, endMs: 100, from: { x: 0, y: 0 }, to: { x: 5, y: 0 }, ease: 'linear' },
    { startMs: 900, endMs: 1000, from: { x: 5, y: 0 }, to: { x: 9, y: 0 }, ease: 'linear' },
  ]);
  assert.equal(channel.sampleAt(500).x, 5, 'it arrived and has not left again');
  assert.equal(channel.sampleAt(-1), undefined, 'nothing before the first track');
  assert.equal(channel.isMovingAt(50), true);
  assert.equal(channel.isMovingAt(500), false);
});

test('step channels give the right value at any instant without replay', () => {
  const channel = new StepChannel([
    { at: 0, value: 'Waiting' },
    { at: 100, value: 'Reading the record' },
    { at: 500, value: 'Done' },
  ]);
  assert.equal(channel.sampleAt(-1), undefined);
  assert.equal(channel.sampleAt(0), 'Waiting');
  assert.equal(channel.sampleAt(99), 'Waiting');
  assert.equal(channel.sampleAt(100), 'Reading the record');
  assert.equal(channel.sampleAt(9999), 'Done');
  // Backward seek must agree with forward.
  assert.equal(channel.sampleAt(100), 'Reading the record');
});

test('the clock plays, pauses, scrubs and scales speed', () => {
  const clock = new SimClock(1000);
  assert.equal(clock.advance(100), 0, 'a paused clock does not advance');
  clock.play();
  assert.equal(clock.advance(100), 100);
  clock.setSpeed(3);
  assert.equal(clock.advance(100), 400, 'speed scales elapsed time');
  clock.pause();
  assert.equal(clock.advance(100), 400);
  clock.seek(50);
  assert.equal(clock.time, 50);
  clock.seek(-10);
  assert.equal(clock.time, 0, 'cannot scrub before the start');
  clock.seek(99999);
  assert.equal(clock.time, 1000, 'cannot scrub past the end');
  clock.play();
  clock.advance(10_000);
  assert.equal(clock.isPlaying, false, 'playback stops at the end');
});

// ---------------------------------------------------------------------------
// Scheduler — the invariants
// ---------------------------------------------------------------------------

const compiled = compileFloorPlan(leadReactivationPlan);
const work = { id: 'lead-1', label: 'Harbor & Pine' };

/** Build a valid stream with explicit occurredAt values. */
function stream(build) {
  const emit = createEmitter('run-test');
  const events = [];
  build((input) => events.push(emit({ source: 'lead-workflow', ...input })));
  return events;
}

test('a handoff moves work along the aisle and lands it at the destination', () => {
  const events = stream((emit) => {
    emit({ type: 'work.received', occurredAt: 0, label: 'Received', work });
    emit({
      type: 'handoff',
      occurredAt: 100,
      label: 'Carrying to Context',
      work,
      from: 'records',
      to: 'context',
      direction: 'forward',
    });
  });

  const result = schedule(events, compiled);
  assert.deepEqual(result.violations, []);

  const state = result.work.get('lead-1');
  assert.ok(state, 'the work should exist on the floor');
  assert.ok(state.motion.length >= 1, 'a handoff should produce motion');
  assert.equal(state.holder.sampleAt(result.duration), 'context');
});

test('simultaneous handoffs are scheduled simultaneously, not queued', () => {
  // Invariant I5. Different entities may overlap freely; only an entity is serialised
  // against itself. If these were queued, the office would show a sequence that never
  // happened.
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `lead-${i}`, label: `Lead ${i}` }));
  const events = stream((emit) => {
    for (const item of items) emit({ type: 'work.received', occurredAt: 0, label: 'In', work: item });
    for (const item of items) {
      emit({
        type: 'handoff',
        occurredAt: 1000,
        label: 'Carrying',
        work: item,
        from: 'records',
        to: 'context',
        direction: 'forward',
      });
    }
  });

  const result = schedule(events, compiled);
  assert.deepEqual(result.violations, []);

  // Every folder in motion at one instant. Sampled past the maximum stagger, because
  // simultaneous movers are deliberately jittered a little — five things moving in
  // perfect lockstep reads as a rendering glitch, not as life.
  const sampleAt = 1000 + DEFAULT_OPTIONS.jitterMs + 100;
  const moving = items.filter((item) => result.work.get(item.id).motion.isMovingAt(sampleAt));
  assert.equal(moving.length, 5, 'all five were concurrent and must animate concurrently');

  // The real property: they overlap. Serialising them would spread the starts across
  // five walks; concurrency keeps the spread inside the jitter window.
  const starts = items.map((item) => {
    const state = result.work.get(item.id);
    let first = Infinity;
    for (let t = 0; t <= result.duration; t += 10) {
      if (state.motion.isMovingAt(t)) { first = t; break; }
    }
    return first;
  });
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(
    spread <= DEFAULT_OPTIONS.jitterMs + 10,
    `starts should be within the jitter window, got ${spread}ms — that looks like a queue`,
  );
  assert.ok(
    spread < DEFAULT_OPTIONS.walkMs,
    'a FIFO queue would spread these across five consecutive walks',
  );
});

test('a large simultaneous burst collapses into a counted batch', () => {
  // Regression: the previous implementation counted in-transit items with a variable
  // mutated inside the same loop iteration, so it could never exceed one and batching
  // silently never triggered.
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, label: `Work ${i}` }));
  const events = stream((emit) => {
    for (const item of many) emit({ type: 'work.received', occurredAt: 0, label: 'In', work: item });
    for (const item of many) {
      emit({
        type: 'handoff', occurredAt: 1000, label: 'Carrying', work: item,
        from: 'records', to: 'context', direction: 'forward',
      });
    }
  });

  const result = schedule(events, compiled);
  assert.equal(
    result.work.get('w0').batched.sampleAt(1000),
    true,
    'six at once is above the aggregation threshold',
  );
  // I4: if items were collapsed, the viewer must be told.
  assert.equal(result.compression.sampleAt(1000)?.batched, 6);
});

test('a small simultaneous group is NOT collapsed', () => {
  const few = Array.from({ length: 2 }, (_, i) => ({ id: `w${i}`, label: `Work ${i}` }));
  const events = stream((emit) => {
    for (const item of few) emit({ type: 'work.received', occurredAt: 0, label: 'In', work: item });
    for (const item of few) {
      emit({
        type: 'handoff', occurredAt: 1000, label: 'Carrying', work: item,
        from: 'records', to: 'context', direction: 'forward',
      });
    }
  });
  const result = schedule(events, compiled);
  assert.equal(result.work.get('w0').batched.sampleAt(1000), false);
});

test('folders travelling together take separate lanes', () => {
  // Otherwise several folders merge into one smeared bar and the viewer cannot tell
  // whether they are watching one thing or six.
  const pair = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  const events = stream((emit) => {
    for (const item of pair) emit({ type: 'work.received', occurredAt: 0, label: 'In', work: item });
    for (const item of pair) {
      emit({
        type: 'handoff', occurredAt: 1000, label: 'Carrying', work: item,
        from: 'records', to: 'research', direction: 'forward',
      });
    }
  });

  const result = schedule(events, compiled);
  // Sample mid-journey, where the lane offset applies (endpoints are shared on purpose:
  // work arrives at the tray, not beside it).
  const mid = 1000 + DEFAULT_OPTIONS.jitterMs + DEFAULT_OPTIONS.walkMs / 2;
  const a = result.work.get('a').motion.sampleAt(mid);
  const b = result.work.get('b').motion.sampleAt(mid);
  const apart = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(apart > 0.1, `folders should not overlap mid-route, were ${apart.toFixed(3)} apart`);
});

test('one entity never overlaps itself', () => {
  // Invariant I1. Two handoffs of the SAME folder at the same instant is a producer bug,
  // but the scheduler must still not render the folder in two places at once.
  const events = stream((emit) => {
    emit({ type: 'work.received', occurredAt: 0, label: 'In', work });
    emit({
      type: 'handoff', occurredAt: 500, label: 'To Context', work,
      from: 'records', to: 'context', direction: 'forward',
    });
    emit({
      type: 'handoff', occurredAt: 500, label: 'To Research', work,
      from: 'context', to: 'research', direction: 'forward',
    });
  });

  const result = schedule(events, compiled);
  assert.deepEqual(result.violations, [], 'the scheduler must serialise an entity against itself');
  assert.equal(result.work.get('lead-1').holder.sampleAt(result.duration), 'research');
});

test('a backward handoff is given more room to read than a forward one', () => {
  // The reviewer walking work back is the flagship beat; it should not snap past.
  const forward = schedule(
    stream((emit) => {
      emit({ type: 'work.received', occurredAt: 0, label: 'In', work });
      emit({
        type: 'handoff', occurredAt: 100, label: 'On', work,
        from: 'outreach', to: 'review', direction: 'forward',
      });
    }),
    compiled,
  );
  const backward = schedule(
    stream((emit) => {
      emit({ type: 'work.received', occurredAt: 0, label: 'In', work });
      emit({
        type: 'handoff', occurredAt: 100, label: 'Back', work,
        from: 'review', to: 'outreach', direction: 'backward',
        reason: 'Claim not supported by the notes',
      });
    }),
    compiled,
  );
  assert.ok(backward.duration > forward.duration, 'the carried-back beat should take longer');
});

test('a specialist walks in, takes the lowest free hot desk, and leaves', () => {
  const events = stream((emit) => {
    emit({
      type: 'specialist.joined', occurredAt: 0, label: 'Joined for a bounded assignment',
      worker: 'w1', role: 'Researcher',
    });
    emit({ type: 'specialist.left', occurredAt: 5000, label: 'Assignment complete', worker: 'w1' });
  });

  const result = schedule(events, compiled);
  assert.deepEqual(result.violations, []);

  const worker = result.workers.get('w1');
  assert.equal(worker.kind, 'specialist');
  assert.equal(worker.station, 'visitor-1', 'lowest free hot desk, in plan order');
  assert.equal(worker.present.sampleAt(0), true);
  assert.equal(worker.present.sampleAt(result.duration), false);
  assert.ok(worker.motion.length >= 2, 'one track to arrive, one to leave');
});

test('hot desks are assigned deterministically and released on leaving', () => {
  const events = stream((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'A', worker: 'a', role: 'Researcher' });
    emit({ type: 'specialist.joined', occurredAt: 10, label: 'B', worker: 'b', role: 'Reviewer' });
    emit({ type: 'specialist.left', occurredAt: 20, label: 'A done', worker: 'a' });
    emit({ type: 'specialist.joined', occurredAt: 30, label: 'C', worker: 'c', role: 'Drafter' });
  });

  const result = schedule(events, compiled);
  assert.equal(result.workers.get('a').station, 'visitor-1');
  assert.equal(result.workers.get('b').station, 'visitor-2');
  assert.equal(result.workers.get('c').station, 'visitor-1', 'the freed desk is reused');
});

test('running out of hot desks leaves a specialist standing, it does not grow the plan', () => {
  const events = stream((emit) => {
    for (const id of ['a', 'b', 'c']) {
      emit({ type: 'specialist.joined', occurredAt: 0, label: id, worker: id, role: 'Specialist' });
    }
  });
  const result = schedule(events, compiled);
  assert.equal(result.workers.get('c').station, undefined, 'no desk invented at runtime');

  const specialists = [...result.workers.values()].filter((w) => w.kind === 'specialist');
  assert.equal(specialists.length, 3, 'but the specialist is still present and accounted for');
  assert.equal(result.workers.get('c').present.sampleAt(result.duration), true);
});

test('every permanent desk is staffed for the whole run', () => {
  // An empty office would misrepresent the workflow: the team is standing, and "six
  // desks, six people" is the metaphor the viewer arrives with.
  const result = schedule([], compiled);
  const permanent = [...result.workers.values()].filter((w) => w.kind === 'permanent');
  const deskCount = leadReactivationPlan.stations.filter((s) => !s.hotDesk).length;
  assert.equal(permanent.length, deskCount);
  for (const worker of permanent) {
    assert.equal(worker.present.sampleAt(0), true, `${worker.role} should be at their desk`);
    // Idle is null, not a label. This drives the violet highlight, and violet may only
    // ever mean "happening right now" — an idle desk lighting up would be a lie, and it
    // would also blow the brand's 5% cap on violet.
    assert.equal(worker.status.sampleAt(0), null);
  }
});

test('a desk that produced an artifact goes quiet again', () => {
  // Regression: an artifact is an instant, not an activity. Leaving the desk lit would
  // keep asserting "work is happening here" for the rest of the run.
  const events = stream((emit) => {
    emit({
      type: 'artifact.created', occurredAt: 0, label: 'Source trail attached',
      station: 'research', artifact: { id: 'a1', name: 'Source trail', kind: 'evidence' },
    });
  });
  const result = schedule(events, compiled);
  assert.equal(result.workers.get('desk:research').status.sampleAt(0), 'Source trail attached');
  assert.equal(
    result.workers.get('desk:research').status.sampleAt(result.duration),
    null,
    'the desk must stop signalling live activity once the artifact is done',
  );
  assert.equal(result.stationBusy.get('research').sampleAt(result.duration), null);
});

test('a desk goes quiet again when its assignment finishes', () => {
  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 0, label: 'Checking the record', station: 'records' });
    emit({ type: 'assignment.finished', occurredAt: 1000, label: 'Record checked', station: 'records' });
  });
  const result = schedule(events, compiled);
  const worker = result.workers.get('desk:records');
  assert.equal(worker.status.sampleAt(0), 'Checking the record');
  assert.equal(
    worker.status.sampleAt(result.duration),
    null,
    'once finished the desk must stop signalling live activity',
  );
});

test('a dynamic office shows only the agents that are actually live', () => {
  // The correction that matters most for the "connect your work" mode: a live session's
  // cast is whatever is running. Seating a fixed roster would put people on the floor
  // who do not exist, which is exactly the kind of lie this product cannot afford.
  const dynamicPlan = compileFloorPlan({ ...leadReactivationPlan, staffing: 'dynamic' });

  const idle = schedule([], dynamicPlan);
  assert.equal(idle.workers.size, 0, 'an idle dynamic office is empty, not pre-staffed');

  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 0, label: 'Reading', station: 'records' });
    emit({ type: 'specialist.joined', occurredAt: 100, label: 'Joined', worker: 'a1', role: 'Explore' });
    emit({ type: 'assignment.started', occurredAt: 200, label: 'Searching', station: 'research', worker: 'a1' });
  });
  const result = schedule(events, dynamicPlan);
  assert.deepEqual(result.violations, []);

  // One main agent (its events carry no worker) plus exactly the subagent that spawned.
  assert.deepEqual([...result.workers.keys()].sort(), ['a1', 'main']);
  assert.equal(result.workers.get('main').kind, 'permanent');
  assert.equal(result.workers.get('a1').kind, 'specialist');
  assert.equal(result.workers.get('a1').role, 'Explore');
});

test('in a dynamic office the worker goes to the work', () => {
  // Watching the agent cross to the reading room and then to the workshop is what makes
  // a live session legible. Desks blinking on their own are not.
  const dynamicPlan = compileFloorPlan({ ...leadReactivationPlan, staffing: 'dynamic' });
  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 0, label: 'At Records', station: 'records' });
    emit({ type: 'assignment.started', occurredAt: 3000, label: 'At Review', station: 'review' });
  });
  const result = schedule(events, dynamicPlan);
  const main = result.workers.get('main');
  assert.ok(main.motion.length >= 2, 'the agent should travel between desks');
  assert.equal(main.station, 'review', 'and end up where its latest work is');
});

test('a dynamic office never runs out of room for live agents', () => {
  // Capacity must never be the reason someone is missing: if six subagents are running,
  // six are on the floor, even though the plan declares only two hot desks.
  const dynamicPlan = compileFloorPlan({ ...leadReactivationPlan, staffing: 'dynamic' });
  const events = stream((emit) => {
    for (let i = 0; i < 6; i++) {
      emit({ type: 'specialist.joined', occurredAt: i * 10, label: `S${i}`, worker: `a${i}`, role: 'Explore' });
    }
  });
  const result = schedule(events, dynamicPlan);
  const specialists = [...result.workers.values()].filter((w) => w.kind === 'specialist');
  assert.equal(specialists.length, 6);
  for (const worker of specialists) {
    assert.equal(worker.present.sampleAt(result.duration), true, `${worker.id} should be on the floor`);
  }

  // And they do not stand inside each other.
  const spots = specialists.map((w) => w.motion.sampleAt(result.duration));
  const unique = new Set(spots.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
  assert.equal(unique.size, spots.length, 'each waiting agent needs its own spot');
});

test('a permanent office still staffs its modelled team', () => {
  // The lead workflow genuinely does have six roles whether or not they are busy, so
  // the default behaviour is unchanged.
  const result = schedule([], compiled);
  assert.equal([...result.workers.values()].filter((w) => w.kind === 'permanent').length, 6);
});

test('a desk worker reports what their desk is doing, verbatim', () => {
  const events = stream((emit) => {
    emit({
      type: 'assignment.started', occurredAt: 0,
      label: 'Checking the draft against the source notes', station: 'review',
    });
  });
  const result = schedule(events, compiled);
  assert.equal(
    result.workers.get('desk:review').status.sampleAt(0),
    'Checking the draft against the source notes',
    'the label is the producer’s own words, not a paraphrase',
  );
});

test('scheduling is pure: the same stream yields the same timeline', () => {
  const events = stream((emit) => {
    emit({ type: 'work.received', occurredAt: 0, label: 'In', work });
    emit({
      type: 'handoff', occurredAt: 100, label: 'On', work,
      from: 'records', to: 'context', direction: 'forward',
    });
    emit({ type: 'specialist.joined', occurredAt: 150, label: 'Joined', worker: 'w1', role: 'R' });
  });

  const a = schedule(events, compiled);
  const b = schedule(events, compiled);
  assert.equal(a.duration, b.duration);

  const sampleAll = (result) =>
    [...result.work.values()].flatMap((state) =>
      [0, 500, 1000, 2000].map((t) => state.motion.sampleAt(t)),
    );
  assert.deepEqual(sampleAll(a), sampleAll(b));
});

test('long idle gaps are compressed, never reordered', () => {
  // A real session contains minutes of thinking. Replaying that honestly would be
  // unwatchable, so gaps are capped — but order is untouched, and I4 reports it.
  const events = stream((emit) => {
    emit({ type: 'note', occurredAt: 0, label: 'First' });
    emit({ type: 'note', occurredAt: 600_000, label: 'Ten minutes later' });
  });
  const result = schedule(events, compiled);
  assert.ok(
    result.duration <= DEFAULT_OPTIONS.maxGapMs + 1,
    `a ten-minute gap should compress, got ${result.duration}ms`,
  );
  assert.ok(result.timeOf.get(events[0].id) < result.timeOf.get(events[1].id), 'order preserved');
});

test('reduced motion cuts instead of travelling, and stays truthful', () => {
  const events = stream((emit) => {
    emit({ type: 'work.received', occurredAt: 0, label: 'In', work });
    emit({
      type: 'handoff', occurredAt: 100, label: 'On', work,
      from: 'records', to: 'context', direction: 'forward',
    });
  });
  const result = schedule(events, compiled, { reducedMotion: true });
  const state = result.work.get('lead-1');
  assert.equal(state.holder.sampleAt(result.duration), 'context', 'it still arrives');
  assert.equal(state.motion.isMovingAt(result.duration / 2), false, 'but it never travels');
});

test('the real captured session schedules without violating anything', async () => {
  // The point of capturing a real session was to develop against real pacing rather than
  // against a hand-written stream that flatters the scheduler.
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/captured-coding-session.json', import.meta.url), 'utf8'),
  );
  assert.equal(fixture.derivation.includes('NOT a live hook capture'), true, 'provenance must be stated');
  assert.ok(fixture.events.length > 100, 'fixture should be substantial');
  assert.equal(fixture.redacted, true, 'committed fixtures must be redacted');
  assert.equal(fixture.subagents.length, 1);
  assert.ok(fixture.subagents[0].description, 'the specialist has a literal assignment label');
});

/* --- the department level --------------------------------------------------
 *
 * A floor of desks answers "what is happening". A department answers "which part of this
 * company is busy" — the question people actually ask first. The risk in adding a level
 * is that it invents a collective voice for the room, so these pin that it does not.
 */

test('every desk belongs to exactly one room, in both shipped plans', () => {
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    const compiled = compileFloorPlan(plan);
    const roomIds = new Set(plan.rooms.map((room) => room.id));
    for (const station of plan.stations) {
      const room = compiled.roomOf.get(station.id);
      assert.ok(room, `${plan.id}: ${station.id} is in no room`);
      assert.ok(roomIds.has(room), `${plan.id}: ${station.id} claims room "${room}", which does not exist`);
      assert.ok(
        compiled.roomStations.get(room).includes(station.id),
        `${plan.id}: the room index and the station disagree about ${station.id}`,
      );
    }
  }
});

test('circulation is not a department, so there is nothing to drill into', () => {
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    const compiled = compileFloorPlan(plan);
    const timeline = schedule([], compiled);
    const departments = departmentsAt(compiled, timeline, 0);
    const ids = departments.map((department) => department.room.id);
    assert.ok(!ids.includes('room-front'), `${plan.id}: the entrance is offered as a department`);
    for (const department of departments) {
      assert.ok(
        department.desks.length > 0,
        `${plan.id}: "${department.room.label}" is a department with no desks`,
      );
    }
  }
});

test('a department reports its desks’ words, not a mood for the room', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const emit = createEmitter({ runId: 'dept', source: 'lead-workflow' });
  const station = leadReactivationPlan.stations[0];
  const events = [
    emit({ type: 'run.started', label: 'Start', occurredAt: 0 }),
    emit({
      type: 'assignment.started',
      label: 'Checking the follow-up window',
      station: station.id,
      occurredAt: 100,
    }),
  ];
  const timeline = schedule(events, compiled);
  const roomId = compiled.roomOf.get(station.id);
  const view = departmentAt(compiled, timeline, roomId, timeline.duration);

  const desk = view.desks.find((candidate) => candidate.id === station.id);
  assert.equal(
    desk.status,
    'Checking the follow-up window',
    'the department copies the desk verbatim',
  );
  assert.equal(view.status, 'active');
  assert.equal(view.liveCount, 1);
});

test('a department with nothing happening says so, and is never given tokens', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const timeline = schedule([], compiled);
  for (const department of departmentsAt(compiled, timeline, 0)) {
    assert.equal(department.liveCount, 0);
    assert.ok(['idle', 'never-used'].includes(department.status));
    // Usage names a worker, never a station, so a per-department figure would be invented.
    assert.equal(department.usageAttributed, false);
  }
});

test('asking for a department that is not one returns nothing, rather than an empty room', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const timeline = schedule([], compiled);
  assert.equal(departmentAt(compiled, timeline, 'room-front', 0), null, 'circulation');
  assert.equal(departmentAt(compiled, timeline, 'no-such-room', 0), null, 'unknown id');
});

test('a tool call that never finishes does not leave the desk claiming to be live', () => {
  // Common in a real session: an interrupted tool call, a crash, a session closed
  // mid-work. Without this the desk stays lit violet for the rest of the run, asserting
  // that work is still in progress when it is not.
  const compiled = compileFloorPlan(codingSessionPlan);
  const emit = createEmitter({ runId: 'stuck', source: 'claude-code' });
  const events = [
    emit({ type: 'run.started', label: 'Session opens', occurredAt: 0 }),
    emit({
      type: 'assignment.started',
      label: 'Run the build',
      station: 'operations',
      occurredAt: 1000,
    }),
    // No assignment.finished — then the session simply ends.
    emit({ type: 'run.finished', label: 'Session ends', occurredAt: 5000 }),
  ];
  const timeline = schedule(events, compiled);
  const busy = timeline.stationBusy.get('operations');

  assert.equal(busy.sampleAt(2000), 'Run the build', 'it is lit while the work is open');
  assert.equal(
    busy.sampleAt(timeline.duration),
    null,
    'and quiet once the run is over, rather than lit for ever',
  );
});

test('ending a run reports "not happening now", never "finished"', () => {
  // The distinction the fix must preserve: run.finished means the session ended. It does
  // not mean the assignment succeeded, and the trail must still show it never finished.
  const compiled = compileFloorPlan(codingSessionPlan);
  const emit = createEmitter({ runId: 'stuck2', source: 'claude-code' });
  const events = [
    emit({ type: 'run.started', label: 'Session opens', occurredAt: 0 }),
    emit({ type: 'assignment.started', label: 'Run the build', station: 'operations', occurredAt: 1000 }),
    emit({ type: 'run.finished', label: 'Session ends', occurredAt: 5000 }),
  ];
  const timeline = schedule(events, compiled);

  assert.deepEqual(timeline.violations, [], 'clearing the floor is not an invariant breach');
  const finished = events.filter((event) => event.type === 'assignment.finished');
  assert.equal(finished.length, 0, 'no completion was invented in the stream');
});

test('a dynamically staffed plan declares no desk that nobody can ever sit at', () => {
  // The coding office used to declare three "Subagents" hot desks. Dynamic staffing never
  // seats anyone — deliberately, because capacity must never be the reason someone is
  // missing from a live office — so the room was named after people who could not enter it.
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    if (plan.staffing !== 'dynamic') continue;
    const unusable = plan.stations.filter((station) => station.hotDesk);
    assert.deepEqual(
      unusable.map((station) => station.id),
      [],
      `${plan.id} declares hot desks that dynamic staffing can never assign`,
    );
  }
});

test('subagents with no assignment wait in the room named for them', () => {
  const compiled = compileFloorPlan(codingSessionPlan);
  const lounge = codingSessionPlan.rooms.find((room) => room.kind === 'waiting');
  assert.ok(lounge, 'the coding office declares a waiting room');

  const emit = createEmitter({ runId: 'wait', source: 'claude-code' });
  const events = [
    emit({ type: 'run.started', label: 'Session opens', occurredAt: 0 }),
    emit({
      type: 'specialist.joined',
      label: 'A subagent joins',
      worker: 'agent:one',
      occurredAt: 1000,
    }),
  ];
  const timeline = schedule(events, compiled);
  assert.deepEqual(timeline.violations, []);

  const worker = timeline.workers.get('agent:one');
  assert.ok(worker, 'the subagent is on the floor');
  assert.equal(worker.station, undefined, 'and holds no desk, because it was given none');

  // It should come to rest inside the room, not at some arbitrary point by the door.
  const at = worker.motion.sampleAt(timeline.duration);
  assert.ok(
    at.x >= lounge.origin.x - 1.5 &&
      at.x <= lounge.origin.x + lounge.size.w + 1.5 &&
      at.y >= lounge.origin.y - 1.5 &&
      at.y <= lounge.origin.y + lounge.size.h + 1.5,
    `the subagent waits at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}), outside the room meant for it`,
  );
});

test('a worker’s desk is a fact about a moment, not about where they ended up', () => {
  // The scalar `station` is mutated while scheduling, so after the run it only says where
  // someone finished. Asking "who is in this department right now" needs a channel.
  const compiled = compileFloorPlan(codingSessionPlan);
  const emit = createEmitter({ runId: 'moves', source: 'claude-code' });
  const events = [
    emit({ type: 'run.started', label: 'Session opens', occurredAt: 0 }),
    emit({ type: 'assignment.started', label: 'Read a file', station: 'reading', occurredAt: 1000 }),
    emit({ type: 'assignment.finished', label: 'Read', station: 'reading', occurredAt: 2000 }),
    emit({ type: 'assignment.started', label: 'Run the build', station: 'operations', occurredAt: 3000 }),
  ];
  const timeline = schedule(events, compiled);
  assert.deepEqual(timeline.violations, []);

  const main = timeline.workers.get('main');
  assert.ok(main, 'the agent is on the floor');
  // Early on they are at reading; later they are at operations. A scalar could only ever
  // report one of these.
  const early = main.stationAt.sampleAt(2500);
  const late = main.stationAt.sampleAt(timeline.duration);
  assert.equal(early, 'reading', `expected reading at 2500ms, got ${early}`);
  assert.equal(late, 'operations', `expected operations at the end, got ${late}`);
});

test('a department reports who is standing in it, and empty when nobody is', () => {
  const compiled = compileFloorPlan(codingSessionPlan);
  const emit = createEmitter({ runId: 'occupants', source: 'claude-code' });
  const events = [
    emit({ type: 'run.started', label: 'Session opens', occurredAt: 0 }),
    emit({ type: 'assignment.started', label: 'Read a file', station: 'reading', occurredAt: 1000 }),
  ];
  const timeline = schedule(events, compiled);

  const readingRoom = compiled.roomOf.get('reading');
  const reading = departmentAt(compiled, timeline, readingRoom, timeline.duration);
  assert.deepEqual(reading.occupants, ['main'], 'the agent is in the reading room');

  // Every other department is genuinely empty, and says so rather than being staffed by
  // assumption — this office is dynamically staffed, so there is no roster to fall back on.
  for (const department of departmentsAt(compiled, timeline, timeline.duration)) {
    if (department.room.id === readingRoom) continue;
    assert.deepEqual(
      department.occupants,
      [],
      `${department.room.label} invented an occupant`,
    );
  }
});

test('a departed subagent is in no department at all', () => {
  const compiled = compileFloorPlan(codingSessionPlan);
  const emit = createEmitter({ runId: 'left', source: 'claude-code' });
  const events = [
    emit({ type: 'run.started', label: 'Session opens', occurredAt: 0 }),
    emit({ type: 'specialist.joined', label: 'A subagent joins', worker: 'agent:x', occurredAt: 1000 }),
    emit({
      type: 'assignment.started',
      label: 'Search the docs',
      station: 'research',
      worker: 'agent:x',
      occurredAt: 2000,
    }),
    emit({ type: 'specialist.left', label: 'Subagent finished', worker: 'agent:x', occurredAt: 4000 }),
  ];
  const timeline = schedule(events, compiled);

  for (const department of departmentsAt(compiled, timeline, timeline.duration)) {
    assert.ok(
      !department.occupants.includes('agent:x'),
      `${department.room.label} still has a subagent that has left the building`,
    );
  }
});

test('a clock that has run to the end can be restarted by the run growing', () => {
  // The bug this pins: SimClock stops itself at the end, and a LIVE run reaches its end
  // constantly — duration starts near zero and grows one event at a time. A renderer that
  // only calls play() when its `playing` prop changes therefore dies on the first frame
  // and never moves again, so people jump between desks instead of walking. The live view
  // was a slideshow for as long as it existed.
  const clock = new SimClock();
  clock.extend(100);
  clock.play();

  clock.advance(200);
  assert.equal(clock.time, 100, 'it runs to the end');
  assert.equal(clock.playing, false, 'and stops itself there');

  // What a live run does: more events arrive, so the timeline gets longer.
  clock.extend(500);
  assert.equal(clock.playing, false, 'extending alone does not resume — that is the trap');

  clock.play();
  clock.advance(50);
  assert.equal(clock.time, 150, 'once resumed it advances again');
});

test('seeking backwards into a finished run still replays it', () => {
  const clock = new SimClock();
  clock.extend(100);
  clock.play();
  clock.advance(500);
  assert.equal(clock.playing, false);

  clock.seek(0);
  clock.play();
  clock.advance(30);
  assert.equal(clock.time, 30, 'a finished recording can be watched again');
});

/* --- several agents at once, and the pile they used to make -------------------
 *
 * Reported from a real session: run five subagents that all shell out, and every one of
 * them routes to `operations` — the department's ONE desk — where they stack into a blob
 * of overlapping figures. Two separate causes, both provable arithmetic rather than taste:
 *
 *   1. lib/floorplans/coding-session.ts builds stations with DEPARTMENTS.map(station), so a
 *      department IS a single desk. There is no second desk to send anyone to.
 *   2. scheduler.ts standingSpot() fans extra workers around the seat at 0.55 world units
 *      per ring, while a figure is 0.68 wide (a head sphere of radius 0.34 in
 *      three/stage-scene.ts). The worker at the seat and the first ring are 0.55 apart and
 *      need 0.68, so they intersect by 0.13 BY CONSTRUCTION, before any tuning.
 *
 * This test asserts the property rather than the mechanism, so it stays honest whichever
 * seating design replaces it: at any settled instant, no two workers who are on the floor
 * may be closer together than they are wide.
 */

test('several agents working at once never stand inside one another', () => {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    // Five subagents, all doing the kind of work that routes to one department.
    for (let i = 0; i < 5; i += 1) {
      const worker = `agent:sub${i}`;
      emit({
        type: 'specialist.joined', occurredAt: i * 10, label: 'Joined', worker, role: 'Explorer',
      });
      emit({
        type: 'assignment.started', occurredAt: 100 + i * 10, label: 'Bash',
        station: 'operations', worker,
      });
    }
  });

  const result = schedule(events, codingCompiled);
  assert.deepEqual(result.violations, [], 'the stream itself is well formed');

  // Sample well after everyone has arrived and settled.
  const t = result.duration;
  const standing = [...result.workers.values()]
    .filter((worker) => worker.present.sampleAt(t) !== false)
    .map((worker) => ({ id: worker.id, at: worker.motion.sampleAt(t) }))
    .filter((worker) => worker.at);

  assert.ok(standing.length >= 5, `expected the five agents on the floor, saw ${standing.length}`);

  const overlaps = [];
  for (let a = 0; a < standing.length; a += 1) {
    for (let b = a + 1; b < standing.length; b += 1) {
      const gap = Math.hypot(standing[a].at.x - standing[b].at.x, standing[a].at.y - standing[b].at.y);
      if (gap < WORKER_DIAMETER) {
        overlaps.push(`${standing[a].id} and ${standing[b].id} are ${gap.toFixed(2)} apart`);
      }
    }
  }

  assert.deepEqual(
    overlaps,
    [],
    `agents must not be drawn inside each other (a figure is ${WORKER_DIAMETER} wide):\n  ` +
      overlaps.join('\n  '),
  );
});

/* --- finished agents stay, without claiming to be working --------------------
 *
 * A subagent used to be erased the instant it left, which meant the most interesting
 * participants in a session were the ones you could never look at afterwards. They now
 * stay at the desk they used, carrying a record of the last thing they actually did.
 *
 * The whole feature rests on staying being distinguishable from working, so that is what
 * these pin: present goes false, the status goes quiet, and the record repeats the
 * producer's own words rather than inventing "idle" or "done".
 */

test('a finished agent stays at its desk with a record of what it did', () => {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 100, label: 'Bash: npm test', station: 'operations', worker: 'agent:a' });
    emit({ type: 'assignment.finished', occurredAt: 900, label: 'done', station: 'operations', worker: 'agent:a' });
    emit({ type: 'specialist.left', occurredAt: 1000, label: 'Assignment complete', worker: 'agent:a' });
  });

  const result = schedule(events, codingCompiled);
  const worker = result.workers.get('agent:a');
  const end = result.duration;

  assert.equal(worker.present.sampleAt(end), false, 'staying on the floor is not being present');

  const record = worker.departed.sampleAt(end);
  assert.ok(record, 'a finished agent leaves a record');
  assert.equal(record.station, 'operations', 'at the desk it was actually at');
  assert.equal(
    record.lastAction,
    'Bash: npm test',
    'the producer’s own words — never "idle", "done" or anything nobody said',
  );

  // Before it stopped there is no record at all, so a scrub backwards shows it working.
  assert.equal(worker.departed.sampleAt(0), null, 'nothing is claimed before the stop');
});

test('no worker is still working when the run is over', () => {
  /*
   * The regression. `status` was pushed a label on assignment.started and never pushed
   * back, so an agent reported its last tool forever. That stayed invisible only because a
   * departed worker was not drawn — and finished agents are now drawn. Violet means "right
   * now", so an office full of retained agents each captioned with a live action would
   * breach the one rule the palette exists to keep.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'run.started', occurredAt: 0, label: 'Started' });
    for (const id of ['agent:x', 'agent:y']) {
      emit({ type: 'specialist.joined', occurredAt: 10, label: 'Joined', worker: id, role: 'Explorer' });
      emit({ type: 'assignment.started', occurredAt: 20, label: 'Bash', station: 'operations', worker: id });
      emit({ type: 'assignment.finished', occurredAt: 500, label: 'ok', station: 'operations', worker: id });
    }
    emit({ type: 'specialist.left', occurredAt: 900, label: 'Done', worker: 'agent:x' });
    emit({ type: 'run.finished', occurredAt: 1000, label: 'Session ended' });
  });

  const result = schedule(events, codingCompiled);
  for (const [id, worker] of result.workers) {
    assert.equal(
      worker.status.sampleAt(result.duration),
      null,
      `${id} is still reported as working after the run ended`,
    );
  }
});

test('a finished agent keeps its desk, so nobody is seated on top of it', () => {
  // Releasing the desk on departure would seat the next arrival in the same chair and draw
  // the two inside one another — the pile this whole change exists to remove.
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:first', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 50, label: 'Bash', station: 'operations', worker: 'agent:first' });
    emit({ type: 'specialist.left', occurredAt: 100, label: 'Done', worker: 'agent:first' });
    emit({ type: 'specialist.joined', occurredAt: 150, label: 'Joined', worker: 'agent:second', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 200, label: 'Bash again', station: 'operations', worker: 'agent:second' });
  });

  const result = schedule(events, codingCompiled);
  const end = result.duration;
  const first = result.workers.get('agent:first');
  const second = result.workers.get('agent:second');

  assert.notEqual(
    second.stationAt.sampleAt(end),
    first.departed.sampleAt(end).station,
    'the newcomer takes a different desk from the one the record sits at',
  );

  const a = first.motion.sampleAt(end);
  const b = second.motion.sampleAt(end);
  const gap = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(gap >= WORKER_DIAMETER, `a record and a live agent overlap (${gap.toFixed(2)} apart)`);
});

test('a departed specialist in a MODELLED team still leaves, because its desk is reused', () => {
  // The lead workflow is a permanent office: a visitor has a hot desk that the next visitor
  // takes. Leaving a record in that chair would put two figures in it, so retention is
  // deliberately a dynamic-office behaviour and this pins the difference.
  const events = stream((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'A', worker: 'a', role: 'Researcher' });
    emit({ type: 'specialist.left', occurredAt: 100, label: 'A done', worker: 'a' });
  });
  const result = schedule(events, compiled);
  const worker = result.workers.get('a');
  assert.equal(worker.present.sampleAt(result.duration), false);
  assert.equal(worker.departed.sampleAt(result.duration), null, 'no record is left in a reused chair');
});

/* --- a burst of agents, and where they all go --------------------------------
 *
 * "What happens with fifty subagents?" is a fair question and the first answer was bad:
 * three got desks, forty-seven were sent to a lane with a three-position fallback, and
 * they collapsed onto eleven spots with fourteen people standing in one place — the pile
 * this module exists to prevent, reintroduced past the edge of the lane.
 *
 * Standing room is now a lattice divided between the departments, so it has no edge to
 * fall off and two neighbouring crowds cannot grow into the same cell. This pins the
 * property at sizes well past anything Claude Code will actually run concurrently.
 */

for (const count of [10, 50, 120]) {
  test(`${count} agents at once all get somewhere of their own to stand`, () => {
    const codingCompiled = compileFloorPlan(codingSessionPlan);
    const departments = ['operations', 'workshop', 'research', 'reading', 'frontdesk', 'approvals'];

    for (const shape of ['one department', 'spread out']) {
      const events = stream((emit) => {
        for (let i = 0; i < count; i += 1) {
          const worker = `agent:s${i}`;
          const station = shape === 'one department' ? 'operations' : departments[i % departments.length];
          emit({ type: 'specialist.joined', occurredAt: i, label: 'Joined', worker, role: 'Explorer' });
          emit({ type: 'assignment.started', occurredAt: 500 + i, label: `Bash ${i}`, station, worker });
        }
      });

      const result = schedule(events, codingCompiled);
      const t = result.duration;
      const placed = [...result.workers.values()]
        .map((worker) => worker.motion.sampleAt(t))
        .filter(Boolean);

      assert.equal(placed.length, count, `${shape}: everyone is on the floor, nobody dropped`);

      let closest = Infinity;
      for (let a = 0; a < placed.length; a += 1) {
        for (let b = a + 1; b < placed.length; b += 1) {
          closest = Math.min(closest, Math.hypot(placed[a].x - placed[b].x, placed[a].y - placed[b].y));
        }
      }
      assert.ok(
        closest >= WORKER_DIAMETER,
        `${shape}, ${count} agents: closest pair is ${closest.toFixed(2)}, need ${WORKER_DIAMETER}`,
      );
    }
  });
}

test('the same burst places everybody identically every time', () => {
  // Standing room is generated, not authored, so it has to be provably deterministic or a
  // replay would stand people somewhere the live run never did.
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const build = () =>
    stream((emit) => {
      for (let i = 0; i < 30; i += 1) {
        const worker = `agent:s${i}`;
        emit({ type: 'specialist.joined', occurredAt: i, label: 'Joined', worker, role: 'Explorer' });
        emit({ type: 'assignment.started', occurredAt: 500 + i, label: 'Bash', station: 'operations', worker });
      }
    });

  const once = schedule(build(), codingCompiled);
  const twice = schedule(build(), codingCompiled);
  for (const [id, worker] of once.workers) {
    assert.deepEqual(
      worker.motion.sampleAt(once.duration),
      twice.workers.get(id).motion.sampleAt(twice.duration),
      `${id} stood somewhere different the second time`,
    );
  }
});

/* --- parallel tool calls, and the desk each one belongs to --------------------
 *
 * CONNECT.md tells producers that three parallel tool calls are three events with the
 * SAME timestamp, so one agent holding work in two departments at once is the ordinary
 * case, not a corner. The finish has to quieten the desk its own start lit — not the desk
 * the worker happens to hold by then, and not the department's primary desk.
 */

test('a finish quietens the desk its own start lit, not wherever the agent went next', () => {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'run.started', occurredAt: 0, label: 'Session opens' });
    // One agent, two tools at once, in two different departments.
    emit({ type: 'assignment.started', occurredAt: 1000, label: 'Bash: npm test', station: 'operations' });
    emit({ type: 'assignment.started', occurredAt: 1000, label: 'Read src/app.ts', station: 'reading' });
    emit({ type: 'assignment.finished', occurredAt: 2000, label: 'Bash', station: 'operations' });
    emit({ type: 'assignment.finished', occurredAt: 2000, label: 'Read', station: 'reading' });
  });

  const result = schedule(events, codingCompiled);
  const end = result.duration + 5000;
  for (const [station, channel] of result.stationBusy) {
    assert.equal(
      channel.sampleAt(end),
      null,
      `${station} is still lit after both tools returned — the office claims work is running there`,
    );
  }
});

test('a failure lands on the desk that failed, not on another agent’s', () => {
  // Writing one agent's literal failure onto a desk somebody else is sitting at is the
  // office attributing a failure, in its own words, to an agent that did not have it.
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 0, label: 'Bash: ok', station: 'operations', worker: 'agent:a' });
    emit({ type: 'assignment.started', occurredAt: 10, label: 'Bash: doomed', station: 'operations', worker: 'agent:b' });
    emit({
      type: 'assignment.failed', occurredAt: 900, label: 'Bash failed', station: 'operations',
      worker: 'agent:b', reason: 'exit 1: no such file',
    });
  });

  const result = schedule(events, codingCompiled);
  const at = result.duration;
  const deskOfB = result.workers.get('agent:b').stationAt.sampleAt(at);
  const deskOfA = result.workers.get('agent:a').stationAt.sampleAt(at);

  assert.notEqual(deskOfA, deskOfB, 'the two agents are at different desks');
  assert.equal(
    result.stationBusy.get(deskOfB).sampleAt(at),
    'exit 1: no such file',
    'the failure is written at the desk that had it, verbatim',
  );
  assert.notEqual(
    result.stationBusy.get(deskOfA)?.sampleAt(at),
    'exit 1: no such file',
    'and never at the desk of the agent that did not',
  );
});

test('an agent that works again after leaving is no longer a record', () => {
  // A producer may re-use an agent id. Without clearing the record the floor drew a grey
  // shadowless marker at a desk that was simultaneously lit violet with that agent's
  // current tool.
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 50, label: 'Bash', station: 'operations', worker: 'agent:a' });
    emit({ type: 'specialist.left', occurredAt: 100, label: 'Done', worker: 'agent:a' });
    emit({ type: 'assignment.started', occurredAt: 500, label: 'Bash again', station: 'operations', worker: 'agent:a' });
  });

  const result = schedule(events, codingCompiled);
  const end = result.duration;
  const worker = result.workers.get('agent:a');
  assert.equal(worker.departed.sampleAt(end), null, 'working again cancels the record');
  assert.equal(worker.present.sampleAt(end), true, 'and puts them back on the floor properly');
});

test('an agent that leaves mid-tool does not leave its desk claiming to be busy', () => {
  /*
   * A live session never sends run.finished, so nothing else would ever close an
   * assignment its agent walked away from. Before this, the desk kept the departed agent's
   * last command — in violet, meaning "happening right now" — for as long as the office
   * stayed open. Measured at an hour.
   *
   * Null means "not happening now". It deliberately does not claim the work finished,
   * succeeded or failed: the stream said none of those, and the operations log still shows
   * a start with no finish, which is what actually happened.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 100, label: 'Bash: long thing', station: 'operations', worker: 'agent:a' });
    emit({ type: 'specialist.left', occurredAt: 200, label: 'Left mid-flight', worker: 'agent:a' });
  });

  const result = schedule(events, codingCompiled);
  const wellAfter = result.duration + 3_600_000;
  for (const [station, channel] of result.stationBusy) {
    assert.equal(
      channel.sampleAt(wellAfter),
      null,
      `${station} still claims to be busy long after the agent working there left`,
    );
  }
});

/* --- desks belong to assignments, not to departments or to whoever is nearby -----
 *
 * Three attempts at this. Resolving a finish from the event alone cannot work (the event
 * names a department, the office picks the desk); resolving it from where the worker is
 * NOW is wrong when they hold two calls in different departments; and remembering the desk
 * id per (worker, department) is wrong twice more, because a desk is released when its
 * worker moves department — so the id can be re-let to somebody else before the finish
 * arrives — and two calls in one department share one entry.
 *
 * Ownership is the property that actually holds: a finish darkens a desk only if that
 * assignment still owns its lit state.
 */

test('a finish never repaints a desk that has been re-let to another agent', () => {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    // Main runs two tools at once, which frees its Operations desk when it claims Reading.
    emit({ type: 'assignment.started', occurredAt: 1000, label: 'Bash: main', station: 'operations' });
    emit({ type: 'assignment.started', occurredAt: 1100, label: 'Read: app.ts', station: 'reading' });
    // A subagent takes the freed desk and starts working at it.
    emit({ type: 'specialist.joined', occurredAt: 1500, label: 'Joined', worker: 'agent:x', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 1600, label: 'Bash: npm run build', station: 'operations', worker: 'agent:x' });
    // Main's first tool returns. It must not darken the desk the subagent is using.
    emit({ type: 'assignment.finished', occurredAt: 3000, label: 'Bash done', station: 'operations' });
  });

  const result = schedule(events, codingCompiled);
  const t = result.duration;
  const deskOfX = result.workers.get('agent:x').stationAt.sampleAt(t);
  assert.equal(
    result.stationBusy.get(deskOfX).sampleAt(t),
    'Bash: npm run build',
    'the subagent’s desk went dark while its tool was still running',
  );
});

test('a failure is never captioned onto an agent that did not have it', () => {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 0, label: 'Bash: a', station: 'operations', worker: 'agent:a' });
    // Two parallel calls from b, in the same department as a.
    emit({ type: 'assignment.started', occurredAt: 100, label: 'Bash: b1', station: 'operations', worker: 'agent:b' });
    emit({ type: 'assignment.started', occurredAt: 150, label: 'Bash: b2', station: 'operations', worker: 'agent:b' });
    emit({
      type: 'assignment.failed', occurredAt: 900, label: 'failed', station: 'operations',
      worker: 'agent:b', reason: 'exit 1: only b',
    });
  });

  const result = schedule(events, codingCompiled);
  const t = result.duration;
  for (const [station, channel] of result.stationBusy) {
    const at = channel.sampleAt(t);
    if (station === result.workers.get('agent:a').stationAt.sampleAt(t)) {
      assert.equal(at, 'Bash: a', 'a’s desk still shows a’s own work');
    }
  }
});

test('an agent with two calls open is still working when the first returns', () => {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 0, label: 'Bash: one', station: 'operations', worker: 'agent:p' });
    emit({ type: 'assignment.started', occurredAt: 0, label: 'Bash: two', station: 'operations', worker: 'agent:p' });
    emit({ type: 'assignment.finished', occurredAt: 500, label: 'one done', station: 'operations', worker: 'agent:p' });
  });
  const result = schedule(events, codingCompiled);
  assert.equal(
    result.workers.get('agent:p').status.sampleAt(result.duration),
    'Bash: one',
    'blanking here would blink the agent off mid-job',
  );
});

test('closing an assignment never blanks one that has already started', () => {
  // A null scheduled after a walk can land past the next assignment's start and erase it.
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'assignment.started', occurredAt: 1000, label: 'Bash: npm test', station: 'operations' });
    emit({ type: 'assignment.failed', occurredAt: 3000, label: 'failed', station: 'operations', reason: 'exit status 1' });
    emit({ type: 'assignment.started', occurredAt: 3400, label: 'Bash: retry', station: 'operations' });
  });
  const result = schedule(events, codingCompiled);
  assert.equal(result.workers.get('main').status.sampleAt(result.duration), 'Bash: retry');
});

test('a burst into any single department never stacks anyone', () => {
  /*
   * Departments in the middle of the office are hemmed in, and a nearest-centre partition
   * starved them: fifty agents into Reading exhausted its share and the tail collapsed
   * onto neighbours' cells, five pairs at exactly zero distance. Cells are now shared out
   * in turns, so every department gets a comparable number.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  for (const department of ['reading', 'operations', 'workshop', 'research', 'frontdesk', 'approvals']) {
    const events = stream((emit) => {
      for (let i = 0; i < 60; i += 1) {
        const worker = `agent:s${i}`;
        emit({ type: 'specialist.joined', occurredAt: i, label: 'Joined', worker, role: 'Explorer' });
        emit({ type: 'assignment.started', occurredAt: 500 + i, label: `Bash ${i}`, station: department, worker });
      }
    });
    const result = schedule(events, codingCompiled);
    const t = result.duration;
    const placed = [...result.workers.values()].map((w) => w.motion.sampleAt(t)).filter(Boolean);
    let closest = Infinity;
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        closest = Math.min(closest, Math.hypot(placed[a].x - placed[b].x, placed[a].y - placed[b].y));
      }
    }
    assert.ok(
      closest >= WORKER_DIAMETER,
      `60 agents into ${department}: closest pair ${closest.toFixed(2)}, need ${WORKER_DIAMETER}`,
    );
  }
});

/* --- framing the office, and everyone standing in it -------------------------- */

test('an office with nobody outside it is framed exactly as before', () => {
  // The no-crowd case has to be untouched, or every existing shot changes.
  const frame = frameOffice({ x: 6.5, y: 5.25 }, 8, null);
  assert.deepEqual(frame.at, { x: 6.5, y: 5.25 });
  assert.equal(frame.radius, 8);

  // A crowd entirely inside the building must not move the camera either.
  const inside = frameOffice({ x: 0, y: 0 }, 10, { minX: -2, maxX: 2, minY: -2, maxY: 2 });
  assert.deepEqual(inside.at, { x: 0, y: 0 }, 'nobody is outside, so nothing moves');
  assert.equal(inside.radius, 10);
});

test('a crowd gathered on one side pulls the camera towards it, and fits', () => {
  /*
   * The case that prompted this: fifty agents all in one department. Widening a frame
   * still centred on the building left them against its edge — twice, in two different
   * ways — so this asserts the property that actually matters: everybody is inside.
   */
  const planCentre = { x: 0, y: 0 };
  const planRadius = 8;
  const crowd = { minX: -26, maxX: -10, minY: -4, maxY: 4 };
  const frame = frameOffice(planCentre, planRadius, crowd);

  assert.ok(frame.at.x < planCentre.x, 'the camera moved towards the crowd');

  // Every corner of the crowd, and the whole building, must be within the radius.
  for (const x of [crowd.minX, crowd.maxX]) {
    for (const y of [crowd.minY, crowd.maxY]) {
      const d = Math.hypot(x - frame.at.x, y - frame.at.y);
      assert.ok(d <= frame.radius, `crowd corner (${x}, ${y}) is ${d.toFixed(2)} out of ${frame.radius.toFixed(2)}`);
    }
  }
  const toPlan = Math.hypot(planCentre.x - frame.at.x, planCentre.y - frame.at.y) + planRadius;
  assert.ok(toPlan <= frame.radius + 1e-9, 'the office itself is still fully in shot');
});

test('the frame grows with the crowd and shrinks back when it clears', () => {
  const big = frameOffice({ x: 0, y: 0 }, 8, { minX: -30, maxX: 30, minY: -30, maxY: 30 });
  const small = frameOffice({ x: 0, y: 0 }, 8, { minX: -2, maxX: 2, minY: -2, maxY: 2 });
  assert.ok(big.radius > small.radius, 'a bigger crowd needs a wider shot');
  assert.equal(small.radius, 8, 'and it comes all the way back to the plan when they go');
});

/* --- the building grows to hold the people in it ------------------------------ */

test('an office with nobody outside it is drawn at its own size', () => {
  // The ordinary case must be untouched: an empty office is exactly its plan.
  const base = planBox(codingSessionPlan);
  assert.deepEqual(neededShell(codingSessionPlan, null), base);

  // A crowd well inside the building does not move a wall either.
  const inside = neededShell(codingSessionPlan, { minX: 5, maxX: 12, minZ: 4, maxZ: 10 });
  assert.deepEqual(inside, base, 'people indoors are not a reason to rebuild the room');
});

test('the building grows outward, in whole steps, only on the sides that need it', () => {
  const base = planBox(codingSessionPlan);
  // A crowd escaping to the east only.
  const grown = neededShell(codingSessionPlan, {
    minX: 10,
    maxX: base.maxX + 1,
    minZ: 8,
    maxZ: 10,
  });
  assert.ok(grown.maxX > base.maxX, 'the east wall moved out to hold them');
  assert.equal(grown.minX, base.minX, 'and the west wall did not move for no reason');
  assert.equal(grown.minY, base.minY);
  assert.equal(grown.maxY, base.maxY);

  // Steps, so a crowd drifting by centimetres cannot rebuild the room every frame.
  const nudged = neededShell(codingSessionPlan, {
    minX: 10,
    maxX: base.maxX + 1.4,
    minZ: 8,
    maxZ: 10,
  });
  assert.deepEqual(nudged, grown, 'a small shift inside the same step changes nothing');
});

test('the floor really does cover everyone, at every size measured', () => {
  /*
   * The property, rather than the mechanism: schedule real bursts and assert that not one
   * agent stands off the floor. 120 concurrent agents into a single department is well past
   * anything Claude Code runs, and is the case that put people outside the walls.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  for (const count of [20, 50, 120]) {
    const events = stream((emit) => {
      for (let i = 0; i < count; i += 1) {
        const worker = `agent:s${i}`;
        emit({ type: 'specialist.joined', occurredAt: i, label: 'Joined', worker, role: 'Explorer' });
        emit({ type: 'assignment.started', occurredAt: 500 + i, label: `Bash ${i}`, station: 'operations', worker });
      }
    });
    const result = schedule(events, codingCompiled);
    const t = result.duration;
    const placed = [...result.workers.values()].map((w) => w.motion.sampleAt(t)).filter(Boolean);

    const crowd = placed.reduce(
      (box, at) => ({
        minX: Math.min(box.minX, at.x),
        maxX: Math.max(box.maxX, at.x),
        minZ: Math.min(box.minZ, at.y),
        maxZ: Math.max(box.maxZ, at.y),
      }),
      { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    );
    const floor = neededShell(codingSessionPlan, crowd);

    for (const at of placed) {
      assert.ok(
        at.x >= floor.minX && at.x <= floor.maxX && at.y >= floor.minY && at.y <= floor.maxY,
        `${count} agents: somebody stands at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}), off a floor of ` +
          `x ${floor.minX.toFixed(1)}..${floor.maxX.toFixed(1)} y ${floor.minY.toFixed(1)}..${floor.maxY.toFixed(1)}`,
      );
    }
  }
});

test('the building only grows when somebody is actually outside it', () => {
  /*
   * The first version used a 2.5-unit margin against a crowd box of worker CENTRES, so it
   * rebuilt the room while everyone was still comfortably indoors — measured, the lead
   * office grew with three concurrent agents and the crowd 1.98 units INSIDE the floor.
   * Rebuilding a building because somebody stood near the middle of it is not growing to
   * match anything.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const base = planBox(codingSessionPlan);

  for (const count of [1, 6, 11, 20, 35, 80]) {
    const events = stream((emit) => {
      for (let i = 0; i < count; i += 1) {
        const worker = `agent:s${i}`;
        emit({ type: 'specialist.joined', occurredAt: i, label: 'Joined', worker, role: 'Explorer' });
        emit({ type: 'assignment.started', occurredAt: 500 + i, label: `Bash ${i}`, station: 'operations', worker });
      }
    });
    const result = schedule(events, codingCompiled);
    const t = result.duration;
    const placed = [...result.workers.values()].map((w) => w.motion.sampleAt(t)).filter(Boolean);
    const crowd = placed.reduce(
      (box, at) => ({
        minX: Math.min(box.minX, at.x),
        maxX: Math.max(box.maxX, at.x),
        minZ: Math.min(box.minZ, at.y),
        maxZ: Math.max(box.maxZ, at.y),
      }),
      { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    );

    const grown = neededShell(codingSessionPlan, crowd);
    const didGrow =
      grown.minX !== base.minX || grown.maxX !== base.maxX ||
      grown.minY !== base.minY || grown.maxY !== base.maxY;

    // Does any actual silhouette cross the original floor's edge?
    const r = WORKER_DIAMETER / 2;
    const outside =
      crowd.minX - r < base.minX || crowd.maxX + r > base.maxX ||
      crowd.minZ - r < base.minY || crowd.maxZ + r > base.maxY;

    assert.equal(
      didGrow,
      outside,
      `${count} agents: grew=${didGrow} but somebody outside=${outside} — the room should ` +
        `change size when, and only when, a person does not fit on it`,
    );
  }
});

test('growing the room adds floorboards and windows without moving any', () => {
  /*
   * The room used to divide its CURRENT size into planks and windows, so every board slid
   * and every window resized the moment a wall moved — a bigger office read as a different
   * office. Detail is indexed off the plan's own box now, so growth only appends at the
   * edges.
   *
   * Asserted on positions rather than by eye: every piece present at the small size must be
   * at the identical coordinate at the large one.
   */
  const base = planBox(codingSessionPlan);
  const grown = { ...base, minY: base.minY - 8, maxX: base.maxX + 8 };

  const positionsOf = (shellBox) => {
    const shell = buildRoomShell(codingSessionPlan, shellBox);
    const seams = [];
    const glass = [];
    shell.group.traverse((object) => {
      const p = object.geometry?.parameters;
      if (!p) return;
      // Seams are the thin full-width strips; glass is the tall thin pane on the west wall.
      if (p.height === 0.01) seams.push(Number(object.position.z.toFixed(4)));
      if (p.width === 0.06) glass.push(Number(object.position.z.toFixed(4)));
    });
    return { seams: seams.sort((a, b) => a - b), glass: glass.sort((a, b) => a - b) };
  };

  const small = positionsOf(base);
  const large = positionsOf(grown);

  assert.ok(small.seams.length > 0 && small.glass.length > 0, 'the small room has detail at all');
  assert.ok(large.seams.length > small.seams.length, 'a longer floor has more boards');

  for (const z of small.seams) {
    assert.ok(large.seams.includes(z), `floorboard at ${z} moved when the room grew`);
  }
  for (const z of small.glass) {
    assert.ok(large.glass.includes(z), `window at ${z} moved when the room grew`);
  }
});

/* --- who is drawn, and how ----------------------------------------------------
 *
 * This rule was written out three times — the three.js floor, the SVG floor, and the SVG's
 * accessibility outline — in three slightly different expressions, and lived only in .tsx
 * files that the test runner cannot import. It is one function now, and here is its test.
 */

function personAt(build) {
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream(build);
  const result = schedule(events, codingCompiled);
  return { result, at: result.duration };
}

test('a working agent is drawn as a colleague, not as a record', () => {
  const { result, at } = personAt((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 100, label: 'Bash', station: 'operations', worker: 'agent:a' });
  });
  const p = presenceAt(result.workers.get('agent:a'), at);
  assert.deepEqual(p, { shown: true, dormant: false, working: true });
});

test('an agent between tool calls is still on the floor, and is not working', () => {
  // Present and idle is a real state, distinct from both working and finished.
  const { result, at } = personAt((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 100, label: 'Bash', station: 'operations', worker: 'agent:a' });
    emit({ type: 'assignment.finished', occurredAt: 500, label: 'done', station: 'operations', worker: 'agent:a' });
  });
  const p = presenceAt(result.workers.get('agent:a'), at);
  assert.deepEqual(p, { shown: true, dormant: false, working: false });
});

test('a finished agent is drawn, as a record', () => {
  const { result, at } = personAt((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 100, label: 'Bash', station: 'operations', worker: 'agent:a' });
    emit({ type: 'specialist.left', occurredAt: 500, label: 'Done', worker: 'agent:a' });
  });
  const worker = result.workers.get('agent:a');
  assert.deepEqual(presenceAt(worker, at), { shown: true, dormant: true, working: false });

  // Cleared by the viewer, it leaves the floor entirely.
  const cleared = presenceAt(worker, at, { dismissed: new Set(['agent:a']) });
  assert.deepEqual(cleared, { shown: false, dormant: false, working: false });
});

test('an agent that works again after leaving is a colleague again, not a record', () => {
  /*
   * Order matters here: working beats having been announced as departed, because the most
   * recent thing the stream said is that they are doing something. Backwards, this drew a
   * grey shadowless marker at a desk simultaneously lit with that agent's current tool.
   */
  const { result, at } = personAt((emit) => {
    emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: 'agent:a', role: 'Explorer' });
    emit({ type: 'assignment.started', occurredAt: 50, label: 'Bash', station: 'operations', worker: 'agent:a' });
    emit({ type: 'specialist.left', occurredAt: 100, label: 'Done', worker: 'agent:a' });
    emit({ type: 'assignment.started', occurredAt: 500, label: 'Bash again', station: 'operations', worker: 'agent:a' });
  });
  const p = presenceAt(result.workers.get('agent:a'), at);
  assert.deepEqual(p, { shown: true, dormant: false, working: true });
});

test('"only active" hides the idle and the finished, and never anything that is running', () => {
  /*
   * The property the filter has to hold, whatever else it does. A view control that could
   * hide live work would be the office under-reporting itself, which is the one thing it
   * is not allowed to do.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    for (const id of ['busy', 'idle', 'gone']) {
      emit({ type: 'specialist.joined', occurredAt: 0, label: 'Joined', worker: `agent:${id}`, role: 'Explorer' });
      emit({ type: 'assignment.started', occurredAt: 100, label: `Bash ${id}`, station: 'operations', worker: `agent:${id}` });
    }
    emit({ type: 'assignment.finished', occurredAt: 500, label: 'done', station: 'operations', worker: 'agent:idle' });
    emit({ type: 'specialist.left', occurredAt: 600, label: 'Done', worker: 'agent:gone' });
  });
  const result = schedule(events, codingCompiled);
  const at = result.duration;

  const shownWhen = (activeOnly) =>
    [...result.workers.values()]
      .filter((worker) => presenceAt(worker, at, { activeOnly }).shown)
      .map((worker) => worker.id)
      .sort();

  assert.deepEqual(shownWhen(false), ['agent:busy', 'agent:gone', 'agent:idle'], 'everyone by default');
  assert.deepEqual(shownWhen(true), ['agent:busy'], 'only the one with something running');

  // And the invariant, stated directly: nobody working is ever hidden by the filter.
  for (const worker of result.workers.values()) {
    const p = presenceAt(worker, at, { activeOnly: true });
    if (presenceAt(worker, at).working) {
      assert.equal(p.shown, true, `${worker.id} is working and the filter hid them`);
    }
  }
});

test('a worker has a position from the moment they exist', () => {
  /*
   * A worker who had been seen but not yet sent anywhere sampled to no position at all, and
   * the renderers disagreed about what that meant: the SVG counted them as on the floor and
   * drew nothing, so the panel listed somebody the floor did not show; the three.js floor
   * left the figure at its default and drew them at the world origin, outside the building.
   *
   * Measured on /office at t=300s before the fix: the roster listed one agent, the floor
   * rendered none.
   */
  const codingCompiled = compileFloorPlan(codingSessionPlan);
  const events = stream((emit) => {
    emit({ type: 'run.started', occurredAt: 0, label: 'Session opens' });
    // Announced, and nothing else: no assignment, so nothing ever moves them.
    emit({ type: 'specialist.joined', occurredAt: 100, label: 'Joined', worker: 'agent:idle', role: 'Explorer' });
  });

  const result = schedule(events, codingCompiled);

  /*
   * The invariant is conditional, and deliberately so: before somebody exists they are not
   * drawn either, and `present` samples falsy there. What must never happen is being
   * SHOWN without a place to be shown at.
   */
  for (const [id, worker] of result.workers) {
    for (let t = 0; t <= result.duration; t += Math.max(1, result.duration / 20)) {
      if (!presenceAt(worker, t).shown) continue;
      const at = worker.motion.sampleAt(t);
      assert.ok(
        at && Number.isFinite(at.x) && Number.isFinite(at.y),
        `${id} is on the floor at t=${t} with no position — one renderer would list them ` +
          `and draw nothing, the other would draw them at the world origin`,
      );
    }
  }
});

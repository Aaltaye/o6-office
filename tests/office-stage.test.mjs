/**
 * The 3D stage's testable half.
 *
 * The renderer itself needs a GPU, but the parts most likely to be silently wrong do not:
 * the coordinate mapping between floor-plan space and three.js space, the framing maths,
 * and the deterministic colour assignment. A mirrored axis produces a plausible-looking
 * office with the furniture on the wrong side, which is exactly the kind of bug that
 * survives a visual check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  toScene,
  planCentre,
  planRadius,
  colorForWorker,
  WORKER_COLORS,
  deCollideLabels,
  labelModeFor,
  LABEL_BOX,
  LABEL_BOX_COMPACT,
} from '../lib/office-view/three/stage-scene.ts';
import { leadReactivationPlan } from '../lib/floorplans/lead-reactivation.ts';
import { compileFloorPlan } from '../lib/office-view/core/plan.ts';
import { schedule } from '../lib/office-view/core/scheduler.ts';
import { describeSkipped } from '../lib/office-view/core/timeline.ts';
import { createEmitter } from '../lib/office-view/core/events.ts';
import { codingSessionPlan } from '../lib/floorplans/coding-session.ts';

test('floor-plan space maps to three.js space without mirroring an axis', () => {
  // The plan thinks x-east / y-south / z-up; three thinks y-up / z-depth. Getting this
  // wrong yields a coherent-looking office with everything on the wrong side.
  const point = toScene({ x: 3, y: 7, z: 2 });
  assert.equal(point.x, 3, 'east stays east');
  assert.equal(point.y, 2, 'the plan’s z (height) becomes three’s y (up)');
  assert.equal(point.z, 7, 'the plan’s y (south) becomes three’s z (depth)');
});

test('a point with no height sits on the floor', () => {
  const point = toScene({ x: 1, y: 2 });
  assert.equal(point.y, 0, 'missing z means ground level, not undefined');
});

test('the camera can frame either plan', () => {
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    const centre = planCentre(plan);
    const radius = planRadius(plan);

    assert.ok(Number.isFinite(centre.x) && Number.isFinite(centre.z), `${plan.id}: bad centre`);
    assert.equal(centre.y, 0, 'the camera target sits on the floor');
    assert.ok(radius >= 8, `${plan.id}: radius ${radius} would frame too tightly`);

    // Every desk must fall inside the framing radius, or the camera cuts a department off.
    for (const station of plan.stations) {
      const distance = Math.hypot(station.seat.x - centre.x, station.seat.y - centre.z);
      assert.ok(distance <= radius + 0.001, `${plan.id}: ${station.id} is outside the frame`);
    }
  }
});

test('worker colours are stable, so a replay looks like the run it came from', () => {
  // Same rule as hot-desk and lane assignment: nothing about how the office looks may
  // depend on arrival order or on Math.random.
  assert.equal(colorForWorker('agent:abc'), colorForWorker('agent:abc'));
  assert.notEqual(colorForWorker('main'), colorForWorker('main-2'));
  for (const id of ['main', 'agent:a1', 'desk:records', '']) {
    assert.ok(WORKER_COLORS.includes(colorForWorker(id)), `${id} got a colour off the palette`);
  }
});

test('the cast is colourful but the architecture is not', () => {
  // The deliberate art-direction split: colour identifies people, so it must not also be
  // spent on the building. And violet is reserved for "live" — a worker permanently
  // wearing it would make the one signal that matters unreadable.
  const violet = '#7446ff';
  for (const color of WORKER_COLORS) {
    assert.notEqual(color.toLowerCase(), violet, 'no worker may wear the live colour');
  }
  assert.ok(WORKER_COLORS.length >= 6, 'enough identities that subagents stay distinguishable');
  assert.equal(new Set(WORKER_COLORS).size, WORKER_COLORS.length, 'no duplicate identities');
});

test('labels that collide on screen are pushed apart, and ones that do not are left alone', () => {
  // The real numbers, measured in the browser: Research and Context project 25px apart
  // vertically with overlapping horizontal extents, so Context was drawn over Research.
  const spaced = deCollideLabels({
    research: { left: 392, top: 433, visible: true },
    context: { left: 441, top: 458, visible: true },
    review: { left: 384, top: 562, visible: true },
  });

  assert.equal(spaced.review.top, 562, 'the front-most label is the anchor and does not move');
  assert.ok(
    Math.abs(spaced.research.top - spaced.context.top) >= LABEL_BOX.h,
    `research and context still overlap: ${spaced.research.top} vs ${spaced.context.top}`,
  );
  assert.ok(spaced.research.top < 433, 'the label behind is lifted, not dropped off the floor');
  assert.equal(spaced.context.top, 458, 'the nearer of the pair keeps its projected position');
});

test('separating labels never changes what a label says or which desk it belongs to', () => {
  // The whole point of the office is that nothing on screen is invented. A legibility
  // pass may move a box; it may not drop one, rename one, or reassign it to another desk.
  const input = {
    a: { left: 100, top: 200, visible: true },
    b: { left: 100, top: 210, visible: true },
    c: { left: 900, top: 900, visible: false },
  };
  const spaced = deCollideLabels(input);

  assert.deepEqual(Object.keys(spaced).sort(), ['a', 'b', 'c'], 'every desk keeps its label');
  for (const id of ['a', 'b', 'c']) {
    assert.equal(spaced[id].left, input[id].left, `${id} was moved sideways, off its desk`);
    assert.equal(spaced[id].visible, input[id].visible, `${id} changed visibility`);
  }
  assert.deepEqual(spaced.c, input.c, 'an off-frame label is left exactly as it was');
});

test('label separation is deterministic, so a replay looks like the run it came from', () => {
  const input = {
    a: { left: 100, top: 300, visible: true },
    b: { left: 120, top: 320, visible: true },
    c: { left: 140, top: 340, visible: true },
  };
  assert.deepEqual(deCollideLabels(input), deCollideLabels(input));
  // Already-separated labels are a fixed point: running the pass twice changes nothing.
  assert.deepEqual(deCollideLabels(deCollideLabels(input)), deCollideLabels(input));
});

/* --- narrow stages ---------------------------------------------------------
 *
 * Six full-size labels cannot be placed on a phone-width canvas. What matters is not that
 * they fit, but WHICH text is allowed to disappear when they do not: never a producer's.
 */

test('a dot never replaces a literal status, at any width', () => {
  // The honesty invariant, as an assertion over the whole cross product. "Standing by" is
  // written by the renderer for an idle desk; every other status came from a producer.
  for (const isNarrow of [true, false]) {
    for (const isSelected of [true, false]) {
      assert.equal(
        labelModeFor({ isNarrow, status: 'Reading src/app.ts', isSelected }),
        'label',
        'a desk doing something always says what',
      );
    }
  }
  assert.equal(labelModeFor({ isNarrow: true, status: null, isSelected: false }), 'dot');
  assert.equal(
    labelModeFor({ isNarrow: true, status: null, isSelected: true }),
    'label',
    'the desk the viewer picked keeps its label',
  );
  assert.equal(
    labelModeFor({ isNarrow: false, status: null, isSelected: false }),
    'label',
    'nothing collapses on a wide stage',
  );
});

test('the label carrying a live status is never the one that moves', () => {
  const spaced = deCollideLabels({
    idle: { left: 200, top: 300, visible: true },
    live: { left: 210, top: 320, visible: true, active: true },
  });
  assert.equal(spaced.live.top, 320, 'the live label stays on its own desk');
  assert.notEqual(spaced.idle.top, 300, 'the idle one gives way');
  assert.ok(
    Math.abs(spaced.live.top - spaced.idle.top) >= LABEL_BOX.h,
    'and they no longer overlap',
  );
});

test('no label is ever lifted out of the frame in silence', () => {
  // The overlay clips with overflow:hidden, so an unbounded lift could hide a label while
  // still calling it visible. A dot is an honest "there is a desk here"; a clipped label
  // is just missing.
  // A frame with room for about three stacked labels, and six desks that all project to
  // the same spot — so some genuinely cannot be placed.
  const stack = {};
  for (let i = 0; i < 6; i += 1) stack[`desk${i}`] = { left: 160, top: 140 + i, visible: true };
  const spaced = deCollideLabels(stack, { frameHeight: 150 });

  for (const [id, point] of Object.entries(spaced)) {
    if (point.collapsed) continue;
    assert.ok(point.top - LABEL_BOX.h >= 0, `${id} was placed off the top of the frame`);
  }
  assert.ok(
    Object.values(spaced).some((point) => point.collapsed),
    'the ones that could not fit say so, rather than vanishing',
  );
  assert.equal(Object.keys(spaced).length, 6, 'every desk is still accounted for');
});

test('a live label that cannot fit overlaps rather than disappearing', () => {
  const stack = { live: { left: 160, top: 20, visible: true, active: true } };
  for (let i = 0; i < 5; i += 1) {
    stack[`idle${i}`] = { left: 160, top: 300 + i, visible: true };
  }
  const spaced = deCollideLabels(stack, { frameHeight: 200 });
  assert.equal(spaced.live.collapsed, undefined, 'a live label is never collapsed to a dot');
  assert.ok(spaced.live.visible, 'and never hidden');
});

test('placement measures the box it is told to, not a hard-coded one', () => {
  const pair = {
    a: { left: 100, top: 300, visible: true },
    b: { left: 172, top: 320, visible: true },
  };
  // 72px apart: overlapping at the full idle width of 80, clear at the compact 66.
  const full = deCollideLabels(pair, { box: LABEL_BOX });
  const compact = deCollideLabels(pair, { box: LABEL_BOX_COMPACT });
  // b is bottom-most, so it anchors and a is the one that has to give way - or not.
  assert.notEqual(full.a.top, 300, 'the full-size boxes collide, so a is lifted');
  assert.equal(compact.a.top, 300, 'the compact ones clear each other, so nothing moves');
});

test('the compact label size in CSS matches the box placement measures', () => {
  // These numbers have to live in two files. A test is the only thing that keeps them
  // equal, and a silent mismatch means de-collision measures a box nobody is drawing.
  const css = readFileSync(new URL('../lib/office-view/office-view.css', import.meta.url), 'utf8');
  const widthIn = (selector) => {
    const block = css.slice(css.indexOf(selector));
    const match = block.slice(0, block.indexOf('}')).match(/max-width:\s*(\d+)px/);
    return match ? Number(match[1]) : null;
  };
  assert.equal(widthIn('.office-label {'), LABEL_BOX.activeW, 'full-size cap drifted');
  assert.equal(
    widthIn('.office-view.is-narrow .office-label {'),
    LABEL_BOX_COMPACT.activeW,
    'compact cap drifted',
  );
});

test('live labels that cannot all fit stay in frame and never land on the same pixel', () => {
  // Found by adversarial review and reproduced before fixing: every unplaceable live label
  // was clamped to the same top edge, so several sat on one pixel and read as a single
  // label — the exact failure this pass exists to prevent, relocated. Cascading by a full
  // label height instead ran them off the bottom, which the overlay clips just as quietly.
  for (const [count, frameHeight] of [
    [5, 120],
    [8, 320],
    [3, 200],
  ]) {
    const stack = {};
    for (let i = 0; i < count; i += 1) {
      stack[`live${i}`] = { left: 175, top: 95 + i, visible: true, active: true };
    }
    const spaced = deCollideLabels(stack, { frameHeight });
    const placed = Object.values(spaced);
    const tops = placed.map((point) => point.top);

    assert.equal(
      tops.length - new Set(tops).size,
      0,
      `${count} live labels in ${frameHeight}px: some share an exact position`,
    );
    for (const point of placed) {
      assert.equal(point.collapsed, undefined, 'a live label is never collapsed to a dot');
      assert.ok(point.top - LABEL_BOX.h >= 0, 'nothing is pushed off the top of the frame');
      assert.ok(point.top <= frameHeight, 'nothing is pushed off the bottom either');
    }
  }
});

test('an idle label always yields to a live one, never the other way round', () => {
  // The guarantee is an asymmetry, not "a live label never moves": when two LIVE labels
  // collide one of them has to move, which is arithmetic. What must never happen is
  // "Standing by" pushing a producer's literal action off its own desk.
  for (const [idleTop, liveTop] of [
    [300, 320],
    [320, 300],
    [300, 300],
  ]) {
    const spaced = deCollideLabels({
      idle: { left: 200, top: idleTop, visible: true },
      live: { left: 205, top: liveTop, visible: true, active: true },
    });
    assert.equal(spaced.live.top, liveTop, `live label moved (idle ${idleTop}, live ${liveTop})`);
    assert.notEqual(spaced.idle.top, idleTop, 'the idle one is the one that gives way');
  }
});

test('when two live labels collide, one moves and both stay readable', () => {
  const spaced = deCollideLabels({
    a: { left: 200, top: 300, visible: true, active: true },
    b: { left: 205, top: 310, visible: true, active: true },
  });
  assert.notEqual(spaced.a.top, spaced.b.top, 'they cannot both keep their place');
  assert.ok(
    Math.abs(spaced.a.top - spaced.b.top) >= LABEL_BOX.h,
    'and once separated neither hides the other',
  );
  for (const id of ['a', 'b']) {
    assert.equal(spaced[id].collapsed, undefined, 'neither live label is ever collapsed');
  }
});

test('truncated dead air is reported, not silently swallowed', () => {
  // I4 says compression is always stated. TWO things compress time here: rate-from-debt,
  // which was reported, and gap capping, which was not — despite a comment claiming it
  // was. Gap capping is the one that actually fires: a real session is mostly waiting, so
  // a ten minute pause became 1.4 seconds and the office said nothing at all.
  const compiled = compileFloorPlan(leadReactivationPlan);
  const emit = createEmitter({ runId: 'gap', source: 'lead-workflow' });
  const station = leadReactivationPlan.stations[0].id;
  const events = [
    emit({ type: 'run.started', label: 'Start', occurredAt: 0 }),
    emit({ type: 'assignment.started', label: 'First', station, occurredAt: 1000 }),
    // Ten minutes of nothing, which the scheduler truncates to maxGapMs.
    emit({ type: 'assignment.finished', label: 'Done', station, occurredAt: 600000 }),
  ];
  const timeline = schedule(events, compiled);

  const stated = timeline.compression.sampleAt(timeline.duration);
  assert.ok(stated, 'the run has something to say about how it handled time');
  assert.ok(
    stated.skippedMs > 500000,
    `nearly ten minutes was truncated but only ${stated.skippedMs}ms was reported`,
  );
  assert.ok(timeline.duration < 60000, 'and the run really was compressed into seconds');
  assert.deepEqual(timeline.violations, []);
});

test('a run with no dead air claims none was skipped', () => {
  // The other half of the invariant: never state a compression that did not happen.
  const compiled = compileFloorPlan(leadReactivationPlan);
  const emit = createEmitter({ runId: 'tight', source: 'lead-workflow' });
  const station = leadReactivationPlan.stations[0].id;
  const timeline = schedule(
    [
      emit({ type: 'run.started', label: 'Start', occurredAt: 0 }),
      emit({ type: 'assignment.started', label: 'First', station, occurredAt: 200 }),
      emit({ type: 'assignment.finished', label: 'Done', station, occurredAt: 700 }),
    ],
    compiled,
  );
  const stated = timeline.compression.sampleAt(timeline.duration) ?? { skippedMs: 0 };
  assert.equal(stated.skippedMs, 0, 'nothing was skipped, so nothing is claimed');
});

test('skipped time is described in words a person reads, not milliseconds', () => {
  assert.equal(describeSkipped(45_000), '45s');
  assert.equal(describeSkipped(597_600), '10m');
  assert.equal(describeSkipped(3_600_000), '1h');
  assert.equal(describeSkipped(5_400_000), '1h 30m');
});


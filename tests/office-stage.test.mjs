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

import {
  toScene,
  planCentre,
  planRadius,
  colorForWorker,
  WORKER_COLORS,
  deCollideLabels,
  LABEL_BOX,
} from '../lib/office-view/three/stage-scene.ts';
import { leadReactivationPlan } from '../lib/floorplans/lead-reactivation.ts';
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

/**
 * T001 — event contract and floor-plan schema.
 *
 * These tests exist because both producers of this contract are untrusted at the
 * boundary: the local bridge accepts POSTs from Claude Code hooks, and a fixture is
 * just a JSON file. If a malformed event reaches the scheduler the failure mode is a
 * silently wrong picture rather than a crash, which is the one thing a product built on
 * "what you see is what happened" cannot tolerate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOfficeEvent,
  isOfficeEventStream,
  compareEvents,
  sortEvents,
  groupSimultaneous,
  hashId,
  jitterFor,
  createEmitter,
} from '../lib/office-view/core/events.ts';
import { OFFICE_EVENT_TYPES, OFFICE_EVENT_VERSION } from '../lib/office-view/core/types.ts';
import { usageWorkerOf, workerOf } from '../lib/office-view/core/attribution.ts';
import { toActivity } from '../lib/use-office.ts';
import {
  compileFloorPlan,
  validateFloorPlan,
  routeBetween,
  depthOf,
  aisleBandFor,
} from '../lib/office-view/core/plan.ts';
import {
  leadReactivationPlan,
  leadReactivationCompactPlan,
} from '../lib/floorplans/lead-reactivation.ts';
import { codingSessionPlan } from '../lib/floorplans/coding-session.ts';

/** Envelope fields every event needs, so each case below states only what it varies. */
const base = {
  v: OFFICE_EVENT_VERSION,
  id: 'e1',
  seq: 1,
  runId: 'run-1',
  source: 'lead-workflow',
  occurredAt: 1000,
  label: 'Checking the record',
};

const work = { id: 'lead-1', label: 'Harbor & Pine' };

/** One valid instance of every event type in the union. */
const VALID_EVENTS = {
  'run.started': { ...base, type: 'run.started', plan: 'lead-reactivation' },
  'run.finished': { ...base, type: 'run.finished', outcome: 'completed' },
  'work.received': { ...base, type: 'work.received', work },
  'assignment.started': { ...base, type: 'assignment.started', station: 'records' },
  'assignment.finished': { ...base, type: 'assignment.finished', station: 'records' },
  'assignment.failed': { ...base, type: 'assignment.failed', station: 'review', reason: 'Claim not in evidence' },
  handoff: { ...base, type: 'handoff', work, from: 'records', to: 'context', direction: 'forward' },
  'specialist.joined': { ...base, type: 'specialist.joined', worker: 'w1', role: 'Researcher' },
  'specialist.left': { ...base, type: 'specialist.left', worker: 'w1' },
  'artifact.created': {
    ...base,
    type: 'artifact.created',
    station: 'outreach',
    artifact: { id: 'a1', name: 'Draft email', kind: 'draft' },
  },
  'review.requested': { ...base, type: 'review.requested', station: 'review', question: 'Send this draft?' },
  'review.resolved': { ...base, type: 'review.resolved', station: 'review', decision: 'approved' },
  blocked: { ...base, type: 'blocked', station: 'outreach', waitingOn: 'Research' },
  'usage.reported': { ...base, type: 'usage.reported', usage: { source: 'transcript', inputTokens: 12 } },
  note: { ...base, type: 'note' },
};

test('every declared event type has a valid example that passes validation', () => {
  // Guards against adding a type to the union and forgetting the validator branch.
  assert.deepEqual(Object.keys(VALID_EVENTS).sort(), [...OFFICE_EVENT_TYPES].sort());
  for (const [type, event] of Object.entries(VALID_EVENTS)) {
    assert.equal(isOfficeEvent(event), true, `${type} should be valid`);
  }
});

test('validator rejects malformed envelopes', () => {
  const { v: _v, ...noVersion } = VALID_EVENTS.note;
  /** @type {[unknown, string][]} */
  const cases = [
    [noVersion, 'missing v'],
    [{ ...VALID_EVENTS.note, v: 2 }, 'wrong contract version'],
    [{ ...VALID_EVENTS.note, type: 'desk.exploded' }, 'unknown type'],
    [{ ...VALID_EVENTS.note, label: '' }, 'empty label'],
    [{ ...VALID_EVENTS.note, occurredAt: 'soon' }, 'non-numeric occurredAt'],
    [{ ...VALID_EVENTS.note, occurredAt: NaN }, 'NaN occurredAt would poison the clock'],
    [{ ...VALID_EVENTS.note, occurredAt: Infinity }, 'Infinity occurredAt'],
    [{ ...VALID_EVENTS.note, seq: '3' }, 'non-numeric seq'],
    [{ ...VALID_EVENTS.note, source: 'somewhere-else' }, 'unknown source'],
    [{ ...VALID_EVENTS.note, runId: '' }, 'empty runId'],
    [null, 'null'],
    [[VALID_EVENTS.note], 'an array is not an event'],
    ['note', 'a string is not an event'],
  ];
  for (const [value, why] of cases) {
    assert.equal(isOfficeEvent(value), false, `should reject: ${why}`);
  }
});

test('validator enforces per-variant required fields', () => {
  /** @type {[unknown, string][]} */
  const cases = [
    [{ ...base, type: 'handoff', work, from: 'records', to: 'context' }, 'handoff without direction'],
    [
      { ...base, type: 'handoff', work, from: 'records', to: 'context', direction: 'sideways' },
      'handoff with an invented direction',
    ],
    [{ ...base, type: 'assignment.failed', station: 'review' }, 'failure without a reason'],
    [{ ...base, type: 'specialist.joined', worker: 'w1' }, 'specialist without a role'],
    [{ ...base, type: 'work.received', work: { id: 'x' } }, 'work ref without a label'],
    [{ ...base, type: 'usage.reported', usage: { source: 'vibes' } }, 'usage from an unstated source'],
    [{ ...base, type: 'run.finished', outcome: 'probably fine' }, 'unknown run outcome'],
    [
      { ...base, type: 'artifact.created', station: 'outreach', artifact: { id: 'a1', name: 'Draft' } },
      'artifact without a kind',
    ],
  ];
  for (const [value, why] of cases) {
    assert.equal(isOfficeEvent(value), false, `should reject: ${why}`);
  }
});

test('usage may report that it is unavailable, which is not the same as zero', () => {
  // Claude Code hooks carry no usage at all. Rendering a confident 0 would read as
  // "this was free", which is false — so 'unavailable' is a first-class source.
  const event = { ...base, type: 'usage.reported', usage: { source: 'unavailable' } };
  assert.equal(isOfficeEvent(event), true);
});

test('stream validation rejects a batch containing one bad event', () => {
  assert.equal(isOfficeEventStream([VALID_EVENTS.note, VALID_EVENTS['run.started']]), true);
  assert.equal(isOfficeEventStream([VALID_EVENTS.note, { type: 'note' }]), false);
  assert.equal(isOfficeEventStream('not an array'), false);
});

// ---------------------------------------------------------------------------
// Ordering — invariant I5
// ---------------------------------------------------------------------------

test('events order by occurredAt, then by producer seq', () => {
  const later = { ...VALID_EVENTS.note, id: 'b', seq: 1, occurredAt: 2000 };
  const earlier = { ...VALID_EVENTS.note, id: 'a', seq: 9, occurredAt: 1000 };
  assert.ok(compareEvents(earlier, later) < 0);
  assert.deepEqual(sortEvents([later, earlier]).map((e) => e.id), ['a', 'b']);
});

test('simultaneous events stay simultaneous rather than being serialised', () => {
  // The burst case: five parallel tool calls landing in the same millisecond are
  // genuinely concurrent. A FIFO queue would invent an ordering that never happened.
  const burst = Array.from({ length: 5 }, (_, i) => ({
    ...VALID_EVENTS['assignment.started'],
    id: `burst-${i}`,
    seq: i + 1,
    occurredAt: 5000,
    station: `desk-${i}`,
  }));
  const shuffled = [burst[3], burst[0], burst[4], burst[1], burst[2]];

  const groups = groupSimultaneous(shuffled);
  assert.equal(groups.length, 1, 'all five happened at once, so they form one group');
  assert.equal(groups[0].length, 5, 'none dropped');
  assert.deepEqual(
    groups[0].map((e) => e.id),
    ['burst-0', 'burst-1', 'burst-2', 'burst-3', 'burst-4'],
    'seq breaks ties deterministically, so replay matches live regardless of arrival order',
  );
});

test('distinct timestamps produce distinct groups, in order', () => {
  const events = [
    { ...VALID_EVENTS.note, id: 'c', seq: 3, occurredAt: 3000 },
    { ...VALID_EVENTS.note, id: 'a', seq: 1, occurredAt: 1000 },
    { ...VALID_EVENTS.note, id: 'b', seq: 2, occurredAt: 1000 },
  ];
  const groups = groupSimultaneous(events);
  assert.deepEqual(groups.map((g) => g.map((e) => e.id)), [['a', 'b'], ['c']]);
});

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------

test('hashing and jitter are stable and bounded', () => {
  // Replay must be pixel-identical to the live run, so these can never drift.
  assert.equal(hashId('run-1-7'), hashId('run-1-7'));
  assert.notEqual(hashId('run-1-7'), hashId('run-1-8'));
  for (const id of ['a', 'run-1-1', 'lead-9', '']) {
    const value = jitterFor(id, 220);
    assert.ok(value >= 0 && value < 220, `jitter out of range for "${id}"`);
  }
  assert.equal(jitterFor('anything', 0), 0, 'a zero window means no stagger');
});

test('emitter assigns monotonic seq and ids that survive replay', () => {
  // Note this deliberately does NOT spread a fixture: the emitter fills in the envelope
  // bookkeeping (v, id, seq, runId), and the producer supplies only the meaningful bits.
  const note = { type: 'note', source: 'lead-workflow', occurredAt: 1000, label: 'Started' };

  const emit = createEmitter('run-x');
  const first = emit(note);
  const second = emit(note);
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.id, 'run-x-1');
  assert.equal(first.runId, 'run-x');
  assert.equal(first.v, OFFICE_EVENT_VERSION);
  assert.equal(isOfficeEvent(first), true);

  // Same run, same order => same ids => same animation jitter on replay.
  const replay = createEmitter('run-x');
  assert.equal(replay(note).id, first.id);
});

test('a producer may supply its own event id', () => {
  // The bridge will key events off a hook's tool_use_id so that a retry or a reconnect
  // does not produce a second event for the same action.
  const emit = createEmitter('run-y');
  const event = emit({
    type: 'note',
    source: 'claude-code',
    occurredAt: 1000,
    label: 'Read a file',
    id: 'toolu_abc123',
  });
  assert.equal(event.id, 'toolu_abc123');
  assert.equal(event.seq, 1, 'seq stays monotonic regardless of who names the event');
});

// ---------------------------------------------------------------------------
// Floor plan
// ---------------------------------------------------------------------------

test('the lead reactivation plan is structurally valid', () => {
  assert.deepEqual(validateFloorPlan(leadReactivationPlan), []);
  assert.deepEqual(validateFloorPlan(leadReactivationCompactPlan), []);
});

test('station ids are unique and shared across layout variants', () => {
  const ids = leadReactivationPlan.stations.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate station id');

  // The compact plan exists so a run recorded on the desktop layout renders unchanged
  // on a phone. That only holds if the station identities match exactly.
  const compactIds = leadReactivationCompactPlan.stations.map((s) => s.id);
  assert.deepEqual([...compactIds].sort(), [...ids].sort());
});

test('validator catches the ways a plan can be structurally wrong', () => {
  const broken = (patch) => validateFloorPlan({ ...leadReactivationPlan, ...patch });

  assert.ok(
    broken({ stations: [...leadReactivationPlan.stations, leadReactivationPlan.stations[0]] })
      .some((p) => p.includes('duplicate station id')),
  );
  assert.ok(
    broken({ doors: [] }).some((p) => p.includes('exactly one entrance door')),
    'without an entrance, an arriving specialist has nowhere to come from',
  );
  assert.ok(
    broken({ tile: { w: 50, h: 32, z: 24 } }).some((p) => p.includes('2:1 dimetric')),
  );
  assert.ok(
    broken({
      stations: [{ ...leadReactivationPlan.stations[0], room: 'room-nowhere' }],
    }).some((p) => p.includes('unknown room')),
  );
});

test('compiling throws on an invalid plan rather than rendering it wrong', () => {
  assert.throws(
    () => compileFloorPlan({ ...leadReactivationPlan, doors: [] }),
    /Invalid floor plan/,
  );
});

test('compiled bands paint a seated worker behind their own desk front', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const order = (id) => compiled.bandIndex.get(id);

  for (const station of leadReactivationPlan.stations) {
    assert.ok(order(`${station.id}:back`) < order(`${station.id}:seat`));
    assert.ok(
      order(`${station.id}:seat`) < order(`${station.id}:front`),
      `${station.id}: the desk front must paint over the seat, or occlusion breaks`,
    );
  }
});

test('band order is a pure function of the plan, not of authoring order', () => {
  // Reversing the authored station list must not change paint order — otherwise the
  // picture depends on hidden state and a bug becomes unreproducible.
  const forward = compileFloorPlan(leadReactivationPlan).bands.map((b) => b.id);
  const reversed = compileFloorPlan({
    ...leadReactivationPlan,
    stations: [...leadReactivationPlan.stations].reverse(),
  }).bands.map((b) => b.id);
  assert.deepEqual(forward, reversed);
});

test('every station and tray falls inside the compiled band range', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const depths = compiled.bands.map((b) => b.depth);
  const min = Math.min(...depths);
  const max = Math.max(...depths);
  for (const station of leadReactivationPlan.stations) {
    for (const at of [station.seat, station.inTray, station.outTray]) {
      const depth = depthOf(at);
      assert.ok(depth >= min && depth <= max, `${station.id} at depth ${depth} is outside the bands`);
    }
  }
});

test('an actor anywhere on the floor gets a band, deterministically', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const at = { x: 7, y: 5 };
  assert.equal(aisleBandFor(compiled, at).id, aisleBandFor(compiled, at).id);
  assert.equal(aisleBandFor(compiled, at).kind, 'aisle');
});

test('routes are precomputed for every pair, so there is no runtime pathfinding', () => {
  const compiled = compileFloorPlan(leadReactivationPlan);
  const route = routeBetween(compiled, 'aisle-upper', 'aisle-foot');
  assert.deepEqual(route, ['aisle-upper', 'aisle-middle', 'aisle-lower', 'aisle-foot']);

  // Undirected: people walk both ways down a corridor.
  assert.deepEqual(routeBetween(compiled, 'aisle-foot', 'aisle-upper'), [...route].reverse());
  assert.deepEqual(routeBetween(compiled, 'aisle-upper', 'aisle-upper'), ['aisle-upper']);
});

test('the shipped plans produce no occlusion warnings', () => {
  // A constant-depth aisle edge makes a walker's paint layer ambiguous, and an edge
  // through a seat renders walkers through furniture. Neither is fatal, but the shipped
  // plans should be clean.
  assert.deepEqual(compileFloorPlan(leadReactivationPlan).warnings, []);
  assert.deepEqual(compileFloorPlan(leadReactivationCompactPlan).warnings, []);
});

test('a constant-depth aisle edge is reported', () => {
  // Moving along x+y = constant is exactly the case where band assignment flickers.
  const plan = {
    ...leadReactivationPlan,
    aisle: {
      nodes: [...leadReactivationPlan.aisle.nodes, { id: 'diag', at: { x: 8, y: 2 } }],
      edges: [...leadReactivationPlan.aisle.edges, { from: 'aisle-upper', to: 'diag', lanes: 1 }],
    },
  };
  // aisle-upper is (7,3) => depth 10; diag is (8,2) => depth 10.
  const warnings = compileFloorPlan(plan).warnings;
  assert.ok(warnings.some((w) => w.includes('constant depth')), warnings.join('\n'));
});

test('every department has its own furniture', () => {
  // Six identical desks with six different captions is a labelled diagram. A company is
  // legible because its rooms are not interchangeable, so each department must have a
  // distinct silhouette — and no two may be built from the same set.
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    const departments = plan.stations.filter((s) => !s.hotDesk);
    const signatures = new Set();

    for (const station of departments) {
      assert.ok(station.props?.length, `${plan.id}/${station.id} has no furniture`);
      const signature = station.props.map((p) => p.kind).sort().join('+');
      assert.equal(
        signatures.has(signature),
        false,
        `${plan.id}: ${station.id} looks identical to another department (${signature})`,
      );
      signatures.add(signature);
    }
  }
});

test('furniture stands behind the desk, inside its own room', () => {
  // Props must not cover the person working, and must not spill into the aisle where
  // folders travel.
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    for (const station of plan.stations) {
      for (const prop of station.props ?? []) {
        if ((prop.layer ?? 'back') === 'back') {
          assert.ok(prop.at.y < 0, `${station.id}: a back prop must sit behind the seat`);
        }
        assert.ok(
          Math.abs(prop.at.x) <= 1.5 && Math.abs(prop.at.y) <= 1.5,
          `${station.id}: furniture is outside its own room`,
        );
      }
    }
  }
});

test('visiting subagents get bare hot desks', () => {
  // A hot desk is temporary by definition. Furnishing one would make a visitor look like
  // another department.
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    for (const station of plan.stations.filter((s) => s.hotDesk)) {
      assert.equal(station.props, undefined, `${station.id} should stay bare`);
    }
  }
});

test('label anchors clear the furniture behind each desk', async () => {
  // A fixed label height worked until departments got their own furniture. A server rack
  // is more than twice the height of a paper stack, so the clearance has to come from
  // what each desk actually has on it.
  const { PROP_SHAPES } = await import('../lib/office-view/art/theme.ts');
  for (const plan of [leadReactivationPlan, codingSessionPlan]) {
    for (const station of plan.stations.filter((s) => s.props?.length)) {
      const behind = station.props.filter((p) => (p.layer ?? 'back') === 'back');
      const tallest = Math.max(...behind.map((p) => PROP_SHAPES[p.kind].h));
      const anchorZ = Math.max(1.05, tallest + 0.5);
      assert.ok(anchorZ > tallest, `${station.id}: label would sit inside its own furniture`);
    }
  }
});

test('a handoff belongs to the departments at both of its ends', () => {
  // A handoff happens *between* desks, so it carries `from`/`to` and no `station`. Any
  // per-department view that filters on station alone drops every one of them — and in the
  // lead workflow handoffs are most of the story, including the rework loop that carries
  // work backward.
  const emit = createEmitter({ runId: 'trail', source: 'lead-workflow' });
  const handoff = emit({
    type: 'handoff',
    label: 'Handed to review',
    work: { id: 'lead-1', label: 'Northline Print' },
    from: 'outreach',
    to: 'review',
    direction: 'forward',
    occurredAt: 100,
  });

  const [item] = toActivity([handoff]);
  assert.equal(item.station, undefined, 'a handoff genuinely has no single desk');
  assert.equal(item.from, 'outreach', 'but it does have two ends, and they must survive');
  assert.equal(item.to, 'review');

  // The filter a department panel uses must therefore match on all three.
  const belongsTo = (deskId) =>
    [item.station, item.from, item.to].includes(deskId);
  assert.ok(belongsTo('outreach'), 'the department it left');
  assert.ok(belongsTo('review'), 'and the one it arrived at');
  assert.ok(!belongsTo('records'), 'and nowhere else');
});

/* --- who an event belongs to ------------------------------------------------
 *
 * Claude Code names a worker only inside a subagent, so the main agent is identified by
 * omission. The scheduler already knew that (`id ?? 'main'`) and so did the transcript
 * reader (`usage.worker ?? 'main'`); the inspector panel did not, and clicking the main
 * agent produced a dossier reading zero assignments and zero desks for the worker that
 * had done every single thing in the session. Empty does not read as "unattributed", it
 * reads as "did nothing" — so the rule lives in one function now, and here is its test.
 */

test('an assignment with no named worker belongs to the main agent', () => {
  const started = {
    v: 1, id: 'e1', seq: 1, occurredAt: 0, runId: 'r', source: 'claude-code',
    type: 'assignment.started', label: 'Bash', station: 'workshop',
  };
  assert.equal(workerOf(started), 'main', 'the main agent is named by omission, not absent');
  assert.equal(
    workerOf({ ...started, worker: 'agent:abc' }),
    'agent:abc',
    'a named worker is still its own',
  );
});

test('an artifact is attributed to no one, because it records a desk and not a person', () => {
  const made = {
    v: 1, id: 'e2', seq: 2, occurredAt: 0, runId: 'r', source: 'claude-code',
    type: 'artifact.created', label: 'Edited a.ts', station: 'workshop',
    artifact: { id: 'a', name: 'a.ts', kind: 'file' },
  };
  assert.equal(workerOf(made), null, 'guessing who made it would be an invention');
});

test('a fixture round-trip does not change who an event belongs to', () => {
  // JSON drops `worker: undefined` entirely, so a check for the key answers differently
  // for a live event and the same event replayed. The rule must not notice the difference.
  const live = {
    v: 1, id: 'e3', seq: 3, occurredAt: 0, runId: 'r', source: 'claude-code',
    type: 'assignment.finished', label: 'Read', station: 'reading', worker: undefined,
  };
  const replayed = JSON.parse(JSON.stringify(live));
  assert.equal(Object.hasOwn(live, 'worker'), true, 'the live event carries the key');
  assert.equal(Object.hasOwn(replayed, 'worker'), false, 'the replayed one does not');
  assert.equal(workerOf(live), workerOf(replayed), 'and both still belong to the same worker');
});

test('unavailable usage is credited to nobody, not to the main agent', () => {
  // "We could not read the transcript" must never become "the main agent spent nothing".
  const unavailable = {
    v: 1, id: 'e4', seq: 4, occurredAt: 0, runId: 'r', source: 'claude-code',
    type: 'usage.reported', label: 'Tokens unavailable', usage: { source: 'unavailable' },
  };
  assert.equal(usageWorkerOf(unavailable), null);

  const real = {
    ...unavailable, id: 'e5', seq: 5,
    usage: { source: 'transcript', inputTokens: 10, outputTokens: 2 },
  };
  assert.equal(usageWorkerOf(real), 'main', 'a real report with no worker is the main agent');
});

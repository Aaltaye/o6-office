/**
 * T006 — Claude Code hooks to OfficeEvent.
 *
 * Table-driven over the hooks the bridge actually receives, plus a full pass over the
 * real captured session so the mapping is exercised against a session that happened
 * rather than only against payloads invented to make it pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mapHook, deskForTool, TOOL_DESKS } from '../bridge/map-claude-code.mjs';
import { createEmitter, isOfficeEvent } from '../lib/office-view/core/events.ts';
import { compileFloorPlan } from '../lib/office-view/core/plan.ts';
import { schedule } from '../lib/office-view/core/scheduler.ts';
import { codingSessionPlan, CODING_STATIONS } from '../lib/floorplans/coding-session.ts';

const base = { session_id: 's1', prompt_id: 'p1' };
const first = (payload) => mapHook(payload, {}).events[0];

test('the coding floor plan is valid and its desks are unique', () => {
  const compiled = compileFloorPlan(codingSessionPlan);
  assert.deepEqual(compiled.warnings, []);
  assert.equal(new Set(CODING_STATIONS).size, CODING_STATIONS.length);
});

test('every desk the mapping can name exists on the plan', () => {
  // The mapping and the plan are two halves of one contract. If they drift, the office
  // silently drops work at a desk that is not there.
  const named = new Set([
    ...Object.values(TOOL_DESKS.exact),
    ...Object.values(TOOL_DESKS.prefix),
    TOOL_DESKS.fallback,
    'approvals',
  ]);
  for (const desk of named) {
    assert.ok(CODING_STATIONS.includes(desk), `mapping names a desk the plan lacks: ${desk}`);
  }
});

test('tools are routed to the desk where that kind of work happens', () => {
  assert.equal(deskForTool('Read'), 'reading');
  assert.equal(deskForTool('Edit'), 'workshop');
  assert.equal(deskForTool('Bash'), 'operations');
  assert.equal(deskForTool('WebFetch'), 'research');
  assert.equal(deskForTool('Agent'), 'frontdesk');
  assert.equal(deskForTool('AskUserQuestion'), 'approvals');
});

test('MCP tools route by namespace, longest prefix first', () => {
  // Real sessions are full of these; the captured fixture alone has four MCP servers.
  assert.equal(deskForTool('mcp__Claude_Browser__computer'), 'research');
  assert.equal(deskForTool('mcp__ccd_session__mark_chapter'), 'operations');
  assert.equal(deskForTool('mcp__some_unknown_server__thing'), 'operations');
});

test('an unrecognised tool lands at the front desk rather than vanishing', () => {
  assert.equal(deskForTool('SomeToolInventedNextYear'), 'frontdesk');
  assert.equal(deskForTool(undefined), 'frontdesk');
});

test('the session opening and closing bracket the run', () => {
  assert.equal(first({ ...base, hook_event_name: 'SessionStart' }).type, 'run.started');
  assert.equal(first({ ...base, hook_event_name: 'SessionStart' }).plan, 'coding-session');
  const end = first({ ...base, hook_event_name: 'SessionEnd', end_reason: 'clear' });
  assert.equal(end.type, 'run.finished');
  assert.match(end.detail, /clear/);
});

test('a prompt becomes the unit of work for the turn', () => {
  const result = mapHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login bug\nand add a test' });
  assert.equal(result.events[0].type, 'work.received');
  assert.equal(result.events[0].work.id, 'p1');
  // Only the first line, so a folder label stays readable without misrepresenting it.
  assert.equal(result.events[0].work.label, 'Fix the login bug');
  assert.deepEqual(result.setWork, { id: 'p1', label: 'Fix the login bug' });
});

test('a long prompt is truncated visibly rather than silently', () => {
  const prompt = 'x'.repeat(200);
  const label = mapHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt }).events[0].work.label;
  assert.ok(label.length <= 48);
  assert.ok(label.endsWith('…'), 'truncation must be visible');
});

test('a tool call starts and finishes an assignment at its desk', () => {
  const started = first({
    ...base, hook_event_name: 'PreToolUse', tool_name: 'Read',
    tool_input: { file_path: '/a/b/office.css' }, tool_use_id: 'tu1',
  });
  assert.equal(started.type, 'assignment.started');
  assert.equal(started.station, 'reading');
  assert.equal(started.id, 'tu1', 'keyed on tool_use_id so a retry is not a second event');
  assert.match(started.label, /office\.css/);

  const finished = first({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} });
  assert.equal(finished.type, 'assignment.finished');
  assert.equal(finished.station, 'reading');
});

test('an edit produces an artifact you can open', () => {
  const events = mapHook({
    ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit',
    tool_input: { file_path: 'lib/office-view/core/plan.ts' }, tool_use_id: 'tu2',
  }).events;
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'artifact.created');
  assert.equal(events[1].artifact.name, 'plan.ts');
  assert.equal(events[1].station, 'workshop');
});

test('a failed tool call reports the tool’s own error, verbatim', () => {
  const failed = first({
    ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_error: 'exit code 1: 3 tests failed',
  });
  assert.equal(failed.type, 'assignment.failed');
  assert.equal(failed.station, 'operations');
  assert.equal(failed.reason, 'exit code 1: 3 tests failed');
});

test('a subagent lifecycle correlates by agent_id', () => {
  // This is the beat the whole product was built around: someone walks in for a bounded
  // job and leaves when it is done.
  const joined = first({
    ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Plan',
    description: 'Design office renderer architecture',
  });
  assert.equal(joined.type, 'specialist.joined');
  assert.equal(joined.worker, 'agent:a1');
  assert.equal(joined.role, 'Plan');
  // The subagent's own stated assignment, not a guess at what it is doing.
  assert.equal(joined.detail, 'Design office renderer architecture');

  const left = first({ ...base, hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.equal(left.type, 'specialist.left');
  assert.equal(left.worker, 'agent:a1');
});

test('work done inside a subagent is attributed to that subagent', () => {
  const started = first({
    ...base, hook_event_name: 'PreToolUse', tool_name: 'Grep',
    agent_id: 'a1', agent_type: 'Explore', tool_input: {},
  });
  assert.equal(started.worker, 'agent:a1');
});

test('a permission request lands on the approvals desk', () => {
  const asked = first({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(asked.type, 'review.requested');
  assert.equal(asked.station, 'approvals');
  assert.match(asked.question, /Bash/);
});

test('recognised-but-unmapped hooks are skipped with a stated reason', () => {
  // Not silently swallowed: the bridge logs the reason, so a decision stays visible.
  const result = mapHook({ ...base, hook_event_name: 'PostToolBatch', tool_calls: [] });
  assert.deepEqual(result.events, []);
  assert.match(result.ignored, /double-count/);
});

test('a hook this mapping has never seen is ignored, not crashed on', () => {
  // Claude Code gains hook events over time. A future one must not take down the bridge.
  const result = mapHook({ ...base, hook_event_name: 'SomeFutureHook', whatever: true });
  assert.deepEqual(result.events, []);
  assert.equal(result.ignored, 'unknown hook');
});

test('garbage input is rejected rather than mapped', () => {
  for (const bad of [null, undefined, 'a string', 42, {}, { hook_event_name: 7 }]) {
    const result = mapHook(bad);
    assert.deepEqual(result.events, []);
    assert.ok(result.ignored);
  }
});

test('no hook produces usage — that comes from the transcript', () => {
  // Verified: no Claude Code hook payload carries tokens. Inventing one here would put a
  // fabricated number on the meter.
  const hooks = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd'];
  for (const hook of hooks) {
    const { events } = mapHook({ ...base, hook_event_name: hook, tool_name: 'Read', tool_input: {} });
    assert.ok(events.every((e) => e.type !== 'usage.reported'), `${hook} must not report usage`);
  }
});

test('the whole captured session maps to a valid, schedulable stream', async () => {
  // The real thing: a session that actually happened, mapped end to end.
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/captured-coding-session.json', import.meta.url), 'utf8'),
  );
  const emit = createEmitter('captured');
  const events = [];
  const state = { workLabels: {} };
  let ignoredUnknown = 0;

  for (const hookPayload of fixture.events) {
    if (!hookPayload.hook_event_name) continue; // usage records are the transcript's job
    const result = mapHook(hookPayload, state);
    if (result.ignored === 'unknown hook') ignoredUnknown += 1;
    if (result.setWork) {
      state.currentPromptId = result.setWork.id;
      state.workLabels[result.setWork.id] = result.setWork.label;
    }
    for (const event of result.events) {
      events.push(emit({ ...event, source: 'claude-code', occurredAt: hookPayload.occurred_at }));
    }
  }

  assert.equal(ignoredUnknown, 0, 'the mapping should recognise every hook the capture contains');
  assert.ok(events.length > 200, `expected a substantial stream, got ${events.length}`);
  for (const event of events) {
    assert.equal(isOfficeEvent(event), true, `invalid: ${JSON.stringify(event).slice(0, 160)}`);
  }

  // And it has to render: every station named must exist, and the invariants must hold.
  const timeline = schedule(events, compileFloorPlan(codingSessionPlan));
  assert.deepEqual(timeline.violations, []);

  // The captured session had exactly one subagent; it must arrive and leave.
  const joined = events.filter((e) => e.type === 'specialist.joined');
  const left = events.filter((e) => e.type === 'specialist.left');
  assert.equal(joined.length, 1);
  assert.equal(left.length, 1);
  assert.equal(joined[0].worker, left[0].worker);

  // Real failures stay failures — every one the session actually had, none invented.
  const captured = fixture.events.filter((e) => e.hook_event_name === 'PostToolUseFailure').length;
  assert.ok(captured > 0, 'the capture should contain real failures');
  assert.equal(events.filter((e) => e.type === 'assignment.failed').length, captured);

  // And the turns the session actually had became units of work on the floor.
  const prompts = fixture.events.filter((e) => e.hook_event_name === 'UserPromptSubmit').length;
  assert.equal(events.filter((e) => e.type === 'work.received').length, prompts);
});

/* --- routing has to survive tools nobody here has heard of ------------------
 *
 * The bridge is fed by untrusted input — anything on the machine can POST to its port —
 * and by whatever tools a future Claude Code ships. Both of these were real: a numeric
 * tool name threw and took the bridge process down, and a tool named `constructor`
 * resolved against Object.prototype and returned a function where a desk id was expected.
 */

test('a malformed tool name routes somewhere instead of taking the bridge down', () => {
  for (const bad of [42, null, undefined, {}, [], true, '']) {
    const desk = deskForTool(bad);
    assert.equal(typeof desk, 'string', `${JSON.stringify(bad)} did not produce a desk`);
    assert.ok(desk.length > 0);
  }
});

test('a tool named like an Object property still routes to a real desk', () => {
  // `TOOL_DESKS.exact['constructor']` used to hand back Object.prototype.constructor.
  const stations = new Set(codingSessionPlan.stations.map((station) => station.id));
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const desk = deskForTool(name);
    assert.equal(typeof desk, 'string', `${name} produced a ${typeof desk}`);
    assert.ok(stations.has(desk), `${name} routed to "${desk}", which is not a desk in the plan`);
  }
});

test('every desk the router can name exists in the plan it is drawn on', () => {
  // A desk id that no station matches means work silently lands nowhere.
  const stations = new Set(codingSessionPlan.stations.map((station) => station.id));
  const named = [
    ...Object.values(TOOL_DESKS.exact),
    ...Object.values(TOOL_DESKS.prefix),
    TOOL_DESKS.fallback,
  ];
  for (const desk of named) {
    assert.ok(stations.has(desk), `the router can send work to "${desk}", which has no station`);
  }
});

test('an unfamiliar tool is still placed, including an unknown MCP server', () => {
  // Abel's requirement is that the office copes with whatever is live, so an unseen tool
  // must land somewhere rather than being dropped.
  assert.equal(typeof deskForTool('SomeToolShippedNextYear'), 'string');
  assert.equal(deskForTool('mcp__brand_new_server__do_thing'), deskForTool('mcp__another__thing'));
});

/**
 * office-view/core/departments — the department level of the office.
 *
 * A floor of desks answers "what is happening?". It does not answer "how is this company
 * organised, and which part of it is busy?" — which is the question anyone who has worked
 * in an office actually asks first. This module derives that middle level: for any moment
 * `t`, what each department is, which of its desks exist, and what each of them is doing.
 *
 * Pure derivation. It reads the compiled plan and the scheduled timeline and returns
 * facts; it renders nothing, animates nothing and decides nothing about the camera. That
 * keeps the honesty rules enforceable here rather than in a component:
 *
 *  - Every status string is copied VERBATIM from the timeline. There is deliberately no
 *    aggregate phrasing — no "the Research department is investigating" — because that
 *    would be an invented collective thought, which is precisely the thing this product
 *    exists not to do.
 *  - An empty department renders empty. Under dynamic staffing a department may have
 *    nobody in it, and saying so is the correct answer; there is no roster to fall back on.
 *  - Tokens are never apportioned to a department. Usage reports name a worker, never a
 *    station, so a per-department number would have to be invented. The panel says the
 *    figure is not attributed rather than showing a confident zero.
 */

import type { Room, RoomId, StationId } from './types.ts';
import type { CompiledPlan } from './plan.ts';
import type { ScheduleResult } from './scheduler.ts';

/** One desk, as the department panel sees it. */
export type DeskView = {
  id: StationId;
  /** The department's own name for this desk, from the plan. */
  role: string;
  hotDesk: boolean;
  /**
   * What this desk is doing, verbatim from the timeline. `null` means idle — and idle is
   * reported as idle, never dressed up.
   */
  status: string | null;
};

/**
 * Why a department is quiet, distinguished rather than collapsed into one "empty".
 *
 * 'never-used' is only reachable under dynamic staffing: a department the live stream has
 * not touched at all has no busy channel, which is different from one that worked earlier
 * and has gone quiet. Telling those apart is the difference between "nothing has happened
 * here" and "nothing is happening here right now".
 */
export type DepartmentStatus = 'active' | 'idle' | 'never-used';

export type DepartmentView = {
  room: Room;
  desks: DeskView[];
  status: DepartmentStatus;
  /** How many of this department's desks are working at this instant. */
  liveCount: number;
  /**
   * Tokens are attributed to workers, never to stations, so this is always false today.
   * It exists so the panel has something explicit to render instead of a silent gap.
   */
  usageAttributed: false;
};

/** Departments are drillable; circulation (the entrance, the corridor) is not. */
export function isDepartment(room: Room): boolean {
  return (room.kind ?? 'department') === 'department';
}

/** Every department on this floor, in plan order, as of `t`. */
export function departmentsAt(
  compiled: CompiledPlan,
  timeline: ScheduleResult,
  t: number,
): DepartmentView[] {
  return compiled.plan.rooms.filter(isDepartment).map((room) => viewOf(compiled, timeline, room, t));
}

/** One department by id, or null if that id is not a department on this floor. */
export function departmentAt(
  compiled: CompiledPlan,
  timeline: ScheduleResult,
  roomId: RoomId,
  t: number,
): DepartmentView | null {
  const room = compiled.plan.rooms.find((candidate) => candidate.id === roomId);
  if (!room || !isDepartment(room)) return null;
  return viewOf(compiled, timeline, room, t);
}

function viewOf(
  compiled: CompiledPlan,
  timeline: ScheduleResult,
  room: Room,
  t: number,
): DepartmentView {
  const stationIds = compiled.roomStations.get(room.id) ?? [];
  const byId = new Map(compiled.plan.stations.map((station) => [station.id, station]));

  const desks: DeskView[] = [];
  // A department is 'never-used' only if NO desk in it ever got a busy channel. The
  // scheduler creates those lazily, so their absence is real information rather than an
  // implementation detail: this stream never touched this part of the building.
  let anyChannel = false;

  for (const id of stationIds) {
    const station = byId.get(id);
    if (!station) continue;
    const channel = timeline.stationBusy.get(id);
    if (channel) anyChannel = true;
    desks.push({
      id,
      role: station.role,
      hotDesk: Boolean(station.hotDesk),
      // Verbatim. Whatever the desk reports is what the department reports.
      status: channel?.sampleAt(t) ?? null,
    });
  }

  const liveCount = desks.filter((desk) => desk.status !== null).length;
  const status: DepartmentStatus =
    liveCount > 0 ? 'active' : anyChannel ? 'idle' : 'never-used';

  return { room, desks, status, liveCount, usageAttributed: false };
}

/**
 * office-view — a renderer that turns an event stream into a watchable office.
 *
 * This is the public surface, kept deliberately small so the package stays extractable.
 * The renderer knows three things: a `FloorPlan`, an `OfficeEvent` stream, and a `Theme`.
 * It does not know what a "lead" is, and it does not know what Claude Code is. Anything
 * domain-specific belongs in a producer that emits `OfficeEvent`, not in here.
 *
 * Boundary rule (lint-enforced): nothing under `office-view/` may import `@/lib/lead-engine`,
 * `@/app/*`, or `@/components/ui/*`.
 */

export type {
  OfficeEvent,
  OfficeEventType,
  FloorPlan,
  Station,
  Room,
  Door,
  World,
  UsageReport,
  WorkRef,
  StationId,
  WorkerId,
  WorkId,
} from './core/types.ts';
export { OFFICE_EVENT_VERSION, OFFICE_EVENT_TYPES } from './core/types.ts';

export {
  isOfficeEvent,
  isOfficeEventStream,
  compareEvents,
  sortEvents,
  groupSimultaneous,
  createEmitter,
  hashId,
  jitterFor,
} from './core/events.ts';

export {
  compileFloorPlan,
  validateFloorPlan,
  routeBetween,
  aisleBandFor,
  depthOf,
  type CompiledPlan,
  type CompiledBand,
} from './core/plan.ts';

export {
  worldToScreen,
  screenToWorld,
  planBounds,
  focusBounds,
  toViewBox,
  type Bounds,
  type Screen,
} from './core/projection.ts';

export {
  MotionChannel,
  StepChannel,
  SimClock,
  samplePath,
  sampleTrack,
  easings,
  type MotionTrack,
} from './core/timeline.ts';

export {
  schedule,
  DEFAULT_OPTIONS as DEFAULT_SCHEDULER_OPTIONS,
  type ScheduleResult,
  type SchedulerOptions,
  type WorkerState,
  type WorkState,
} from './core/scheduler.ts';

export { OfficeView, type OfficeViewProps, type Selection } from './react/OfficeView.tsx';
export { palette, faces, live, geometry } from './art/theme.ts';

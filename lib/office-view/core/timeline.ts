/**
 * office-view/core/timeline — the thing that makes replay work.
 *
 * This is the highest-leverage decision in the renderer, so it is worth stating plainly.
 * There are two ways to animate a scene:
 *
 *   (i)  a stateful stepper — `step(state, dt) -> state'`. Rewinding needs snapshots and
 *        reversible logic; scrubbing needs a replay from zero; determinism needs every
 *        frame-rate dependence hunted down.
 *   (ii) timeline evaluation — every motion compiles to an explicit track, and
 *        `sampleAt(t)` is a pure lookup.
 *
 * We take (ii). Then pause is "stop advancing t", scrub is "assign t", speed is "scale
 * dt", and rewind is "decrease t" — all the *same code path*. With (i) each of those is a
 * separate hard problem.
 *
 * The consequence that matters for the product: **replay is the primary system, and live
 * is replay played at its head.** A recorded run is therefore exactly as good as a live
 * one, structurally rather than by discipline — which is what the public demo needs.
 *
 * Non-positional state (a worker's status label, the outbox count) lives in step channels
 * rather than motion tracks, so scrubbing to an arbitrary t yields the correct label with
 * no replay from zero.
 *
 * Boundary rule: imports only sibling core modules.
 */

import type { World } from './types.ts';
import { lerpWorld } from './projection.ts';

/** Normalised easing: takes and returns 0..1. */
export type Easing = (t: number) => number;

export const easings = {
  linear: (t: number) => t,
  /** Default for people and folders — things with mass start and stop gently. */
  easeInOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeOut: (t: number) => 1 - (1 - t) ** 2,
  /**
   * Jump at the end. This is what `prefers-reduced-motion` swaps every easing for:
   * entities cut between states instead of travelling. The scene stays truthful, it just
   * stops moving.
   */
  stepEnd: (t: number) => (t >= 1 ? 1 : 0),
} satisfies Record<string, Easing>;

export type EasingName = keyof typeof easings;

/**
 * One movement. `via` carries the aisle waypoints so a folder follows the corridor rather
 * than sliding through furniture.
 */
export type MotionTrack = {
  startMs: number;
  endMs: number;
  from: World;
  to: World;
  via?: World[];
  ease?: EasingName;
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Position along a polyline at normalised distance `t`, by arc length.
 *
 * Arc length rather than per-segment time so a walker moves at constant speed regardless
 * of how the plan happened to place its waypoints — otherwise a route with one long and
 * one short segment visibly lurches.
 */
export function samplePath(points: World[], t: number): World {
  if (points.length === 0) throw new Error('samplePath needs at least one point');
  if (points.length === 1) return points[0];

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(length);
    total += length;
  }
  // Degenerate route (every waypoint identical) — nothing to interpolate along.
  if (total === 0) return points[points.length - 1];

  let target = clamp01(t) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const local = lengths[i] === 0 ? 1 : clamp01(target / lengths[i]);
      return lerpWorld(points[i], points[i + 1], local);
    }
    target -= lengths[i];
  }
  return points[points.length - 1];
}

/** Full point list for a track, including its endpoints. */
function trackPoints(track: MotionTrack): World[] {
  return track.via && track.via.length > 0
    ? [track.from, ...track.via, track.to]
    : [track.from, track.to];
}

/** Where a track has an entity at time `t`, clamped outside its window. */
export function sampleTrack(track: MotionTrack, t: number): World {
  const duration = track.endMs - track.startMs;
  // A zero-length track is a cut, not an error: it is what invariant I2 produces when a
  // position changed with no event to justify a journey.
  if (duration <= 0) return t < track.startMs ? track.from : track.to;

  const raw = clamp01((t - track.startMs) / duration);
  const eased = easings[track.ease ?? 'easeInOut'](raw);
  return samplePath(trackPoints(track), eased);
}

/**
 * An entity's motion over a whole run.
 *
 * Tracks must be non-overlapping and sorted; the scheduler guarantees that via per-entity
 * cursors (invariant I1: an entity never overlaps itself). A cursor makes monotonic
 * playback O(1) amortised while random seeks stay O(log n).
 */
export class MotionChannel {
  private readonly tracks: MotionTrack[];
  private cursor = 0;

  constructor(tracks: MotionTrack[] = []) {
    this.tracks = [...tracks].sort((a, b) => a.startMs - b.startMs);
  }

  get length(): number {
    return this.tracks.length;
  }

  /** Append a track. Kept sorted; the scheduler appends in order, so this is usually O(1). */
  push(track: MotionTrack): void {
    const last = this.tracks[this.tracks.length - 1];
    if (!last || last.startMs <= track.startMs) this.tracks.push(track);
    else {
      this.tracks.push(track);
      this.tracks.sort((a, b) => a.startMs - b.startMs);
    }
  }

  /** Time at which this entity finishes everything scheduled so far. */
  get busyUntil(): number {
    const last = this.tracks[this.tracks.length - 1];
    return last ? last.endMs : -Infinity;
  }

  /**
   * Index of the last track starting at or before `t`, or -1.
   *
   * Tries the cursor first (playback usually advances by one frame), then falls back to a
   * binary search for a seek.
   */
  private indexAt(t: number): number {
    const tracks = this.tracks;
    if (tracks.length === 0) return -1;

    // Fast path: playback usually advances a frame at a time, so the answer is the
    // cursor or the one after it. Anything else falls through to the binary search,
    // which is what a scrub hits.
    const cursor = this.cursor;
    const holds = (i: number) =>
      i >= 0 && i < tracks.length && tracks[i].startMs <= t && (!tracks[i + 1] || tracks[i + 1].startMs > t);
    if (holds(cursor)) return cursor;
    if (holds(cursor + 1)) {
      this.cursor = cursor + 1;
      return this.cursor;
    }

    let low = 0;
    let high = tracks.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (tracks[mid].startMs <= t) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    this.cursor = found;
    return found;
  }

  /**
   * Position at time `t`, or `undefined` before the entity's first track.
   *
   * Between tracks the entity holds the previous track's destination, which is correct:
   * it arrived and has not left again.
   */
  sampleAt(t: number): World | undefined {
    const index = this.indexAt(t);
    if (index < 0) return undefined;
    return sampleTrack(this.tracks[index], t);
  }

  /** Whether the entity is mid-motion at `t` (used to pick a walking vs seated pose). */
  isMovingAt(t: number): boolean {
    const index = this.indexAt(t);
    if (index < 0) return false;
    const track = this.tracks[index];
    return t >= track.startMs && t < track.endMs && track.endMs > track.startMs;
  }
}

/**
 * Piecewise-constant state over time: status labels, counts, who holds what.
 *
 * Separate from motion because these do not interpolate — a label is one thing and then
 * another. Modelling them as a channel rather than as replayed state is what lets a scrub
 * to any `t` produce the right label immediately.
 */
export class StepChannel<T> {
  private readonly points: { at: number; value: T }[] = [];
  private cursor = 0;

  constructor(points: { at: number; value: T }[] = []) {
    this.points = [...points].sort((a, b) => a.at - b.at);
  }

  get length(): number {
    return this.points.length;
  }

  push(at: number, value: T): void {
    const last = this.points[this.points.length - 1];
    if (!last || last.at <= at) this.points.push({ at, value });
    else {
      this.points.push({ at, value });
      this.points.sort((a, b) => a.at - b.at);
    }
  }

  /** Value in force at `t`, or `undefined` before the first point. */
  sampleAt(t: number): T | undefined {
    const points = this.points;
    if (points.length === 0) return undefined;

    const cursor = this.cursor;
    if (cursor >= 0 && cursor < points.length && points[cursor].at <= t) {
      const next = points[cursor + 1];
      if (!next || next.at > t) return points[cursor].value;
    }

    let low = 0;
    let high = points.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].at <= t) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    this.cursor = found;
    return found < 0 ? undefined : points[found].value;
  }
}

/**
 * The playback clock. Deliberately knows nothing about `Date.now()` — callers feed it
 * real elapsed milliseconds, which keeps the scene deterministic and makes the clock
 * itself trivially testable.
 */
export class SimClock {
  private t = 0;
  private playing = false;
  private rate = 1;

  /** Declared explicitly rather than as a constructor parameter property: these modules
   *  are loaded by `node --test` under strip-only type removal, which cannot erase them. */
  duration: number;

  constructor(duration = 0) {
    this.duration = duration;
  }

  get time(): number {
    return this.t;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get speed(): number {
    return this.rate;
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** Playback speed only. It never changes how fast the underlying work happened. */
  setSpeed(rate: number): void {
    this.rate = Math.max(0.1, rate);
  }

  /** Jump to a time. Scrubbing backward is exactly as cheap as scrubbing forward. */
  seek(t: number): void {
    this.t = Math.max(0, Math.min(t, this.duration));
  }

  /** Advance by real elapsed ms. Returns the new time. Stops at the end. */
  advance(deltaMs: number): number {
    if (!this.playing) return this.t;
    this.t = Math.min(this.t + deltaMs * this.rate, this.duration);
    if (this.t >= this.duration) this.playing = false;
    return this.t;
  }

  /** Extend the timeline as a live run grows at its head. */
  extend(duration: number): void {
    this.duration = Math.max(this.duration, duration);
  }
}

/**
 * A rough, readable duration for the compression badge.
 *
 * Deliberately coarse: the exact figure is not the point, and a precise-looking number
 * would imply a precision the cap does not have. "About nine minutes were not shown" is
 * the honest statement.
 */
export function describeSkipped(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

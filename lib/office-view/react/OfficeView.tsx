'use client';
/* eslint-disable jsx-a11y/prefer-tag-over-role --
 * This rule assumes HTML. Inside SVG there is no <button>, <output> or <img> element to
 * prefer: role= plus explicit keyboard handling IS the accessible construction here, and
 * every interactive shape below carries tabIndex, aria-label and an onKeyDown. The real
 * semantic structure is additionally exposed as a parallel outline tree (OfficeOutline).
 */
/**
 * office-view/react/OfficeView — the office.
 *
 * How the pieces fit:
 *
 *   events ──▶ schedule() ──▶ channels ──▶ rAF loop ──▶ DOM transforms
 *                                   └────▶ throttled React state ──▶ labels, panel
 *
 * React renders the *cast* — which desks exist, which people are currently on the floor,
 * which folders exist — and that changes a handful of times per run. The animation loop
 * renders the *motion*, by writing transforms straight onto registered DOM nodes. It
 * never calls setState. Text that a human reads updates on a throttle, because nobody can
 * read at 60fps.
 *
 * Depth is handled by painting into pre-compiled bands. An actor's band is React state
 * (it changes only when the actor crosses a boundary, a few times per journey), while its
 * position within that band is written imperatively every frame. That gets correct
 * occlusion without re-sorting SVG children per frame, which is the real SVG perf cliff.
 *
 * The camera does not chase the action. Auto-panning to whatever is hot is the single
 * strongest "this is a game" signal, and this is meant to read as an architectural model.
 * Attention is signalled by a soft light pool on the busy room instead; the camera moves
 * only when a human clicks something.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FloorPlan, OfficeEvent, RoomId, Station, StationId, World } from '../core/types.ts';
import { compileFloorPlan, aisleBandFor, type CompiledPlan } from '../core/plan.ts';
import { planBounds, focusBounds, toViewBox, worldToScreen, type Bounds } from '../core/projection.ts';
import { SimClock, describeSkipped } from '../core/timeline.ts';
import { schedule, type ScheduleResult, type SchedulerOptions } from '../core/scheduler.ts';
import { Desk, Door, Folder, Prop, RoomPad, Tray, Worker } from '../art/sprites.tsx';
import { faces, live, palette, PROP_SHAPES, timings } from '../art/theme.ts';
import { useAnimationLoop, useElementSize, usePrefersReducedMotion } from './useAnimationLoop.ts';

/** What the viewer clicked, handed back so the host app can open its own panel. */
export type Selection =
  /**
   * The department level: the floor answers "what is happening", a department answers
   * "which part of this company is busy, and what are its desks doing".
   */
  | { kind: 'department'; id: RoomId }
  | { kind: 'station'; id: StationId }
  | { kind: 'worker'; id: string }
  | { kind: 'work'; id: string }
  | null;

export type OfficeViewProps = {
  plan: FloorPlan;
  events: readonly OfficeEvent[];
  /** Shown verbatim in the corner. The viewer must always know what they are watching. */
  modeLabel: string;
  playing?: boolean;
  /** Playback speed. Never affects how fast the underlying work happened. */
  speed?: number;
  /** Controlled playhead in ms, for an external scrubber. */
  seekMs?: number | null;
  /**
   * Follow the head of the timeline.
   *
   * Live is replay played at its head — so a viewer opening the office ten minutes into
   * a session sees what is happening *now*, not ten minutes of history replaying from
   * the start. Off by default: a recorded run is meant to be watched from the beginning.
   */
  follow?: boolean;
  onTime?: (ms: number, duration: number) => void;
  onSelect?: (selection: Selection) => void;
  selection?: Selection;
  schedulerOptions?: Partial<SchedulerOptions>;
};

/** Human-readable positions the loop writes onto nodes each frame. */
type NodeRegistry = Map<string, SVGGElement | null>;

/** Clear air left between the tallest thing at a desk and its label. */
const LABEL_CLEARANCE = 0.5;
/** How far toward the viewer the label is pulled, so it sits over open floor. */
const LABEL_FORWARD = 0.55;

/**
 * Where a station's label should float.
 *
 * Derived from the department's own furniture rather than fixed: a server rack is more
 * than twice the height of a paper stack, so one height for every desk either clips the
 * tall departments or leaves the short ones drifting. Only furniture *behind* the desk
 * matters, since that is what a label placed above the seat would cover.
 */
function labelAnchorFor(station: Station): World {
  const behind = (station.props ?? []).filter((prop) => (prop.layer ?? 'back') === 'back');
  const tallest = behind.reduce((max, prop) => Math.max(max, PROP_SHAPES[prop.kind].h), 0);
  return {
    x: station.seat.x,
    y: station.seat.y + LABEL_FORWARD,
    z: Math.max(1.05, tallest + LABEL_CLEARANCE),
  };
}

export function OfficeView({
  plan,
  events,
  modeLabel,
  playing = true,
  speed = 1,
  seekMs = null,
  follow = false,
  onTime,
  onSelect,
  selection = null,
  schedulerOptions,
}: OfficeViewProps) {
  const reducedMotion = usePrefersReducedMotion();

  // Compiling and scheduling are pure and not cheap, so they are memoised on identity.
  const compiled: CompiledPlan = useMemo(() => compileFloorPlan(plan), [plan]);
  const timeline: ScheduleResult = useMemo(
    () => schedule(events, compiled, { ...schedulerOptions, reducedMotion }),
    [events, compiled, schedulerOptions, reducedMotion],
  );

  // Invariant breaches are a bug in a producer or in the scheduler. Say so loudly in
  // development rather than rendering a subtly dishonest picture in silence.
  useEffect(() => {
    if (timeline.violations.length > 0) {
      console.error('[office-view] scheduling invariants violated:', timeline.violations);
    }
    if (compiled.warnings.length > 0) {
      console.warn('[office-view] floor plan warnings:', compiled.warnings);
    }
  }, [timeline.violations, compiled.warnings]);

  const clock = useRef<SimClock>(null as unknown as SimClock);
  if (clock.current === null) clock.current = new SimClock(timeline.duration);

  useEffect(() => {
    clock.current.extend(timeline.duration);
  }, [timeline.duration]);

  useEffect(() => {
    if (playing) clock.current.play();
    else clock.current.pause();
  }, [playing]);

  useEffect(() => {
    clock.current.setSpeed(speed);
  }, [speed]);

  // Seeking is handled below, once applyTime exists — a scrub must repaint, not just
  // move the clock.

  const nodes = useRef<NodeRegistry>(new Map());
  const registerNode = useCallback((key: string) => {
    return (element: SVGGElement | null) => {
      if (element) nodes.current.set(key, element);
      else nodes.current.delete(key);
    };
  }, []);

  /**
   * Everything a human reads. Updated on a throttle, not per frame — this is the only
   * React state the loop is allowed to touch, and it does so a few times a second.
   */
  const [readable, setReadable] = useState(() => ({
    t: 0,
    stationStatus: {} as Record<string, string | null>,
    presentWorkers: [] as string[],
    outbox: 0,
    compression: { rate: 1, batched: 0, skippedMs: 0 },
    bands: {} as Record<string, string>,
  }));

  const lastReadableAt = useRef(0);

  // Host callbacks are almost always inline arrows, so their identity changes every
  // render. Holding them in refs keeps `applyTime` and `select` stable.
  const onTimeRef = useRef(onTime);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onTimeRef.current = onTime;
    onSelectRef.current = onSelect;
  });

  /**
   * Render the office at time `t`.
   *
   * Deliberately separate from the animation loop, because time advances for more
   * reasons than a frame tick: scrubbing, pausing, loading a recorded run, or simply
   * mounting. If this lived inside the rAF callback then dragging the scrubber while
   * paused would change the clock and repaint nothing — and a paused, scrubbable replay
   * is the public demo, so it has to be exactly as correct as live playback.
   *
   * `force` bypasses the readable-state throttle, for the one-off repaints above.
   */
  const applyTime = useCallback(
    (t: number, force = false) => {
      // --- 60fps path: write transforms straight onto DOM nodes, no React. ---
      for (const [id, state] of timeline.work) {
        const node = nodes.current.get(`work:${id}`);
        if (!node) continue;
        const at = state.motion.sampleAt(t);
        if (!at) {
          node.style.display = 'none';
          continue;
        }
        node.style.display = '';
        const { sx, sy } = worldToScreen(at, plan.tile);
        node.setAttribute('transform', `translate(${sx.toFixed(2)} ${sy.toFixed(2)})`);
      }

      for (const [id, state] of timeline.workers) {
        const node = nodes.current.get(`worker:${id}`);
        if (!node) continue;
        const present = state.present.sampleAt(t) ?? false;
        // `hidden` rather than removal: React owns the tree, the loop only styles it.
        node.style.display = present ? '' : 'none';
        const at = state.motion.sampleAt(t);
        if (!at) continue;
        const { sx, sy } = worldToScreen(at, plan.tile);
        node.setAttribute('transform', `translate(${sx.toFixed(2)} ${sy.toFixed(2)})`);
      }

      // --- Throttled path: text and structural changes a human can actually read. ---
      // Nobody reads at 60fps, so labels update a few times a second. A forced repaint
      // (a scrub, a mount) always goes through.
      if (!force && Math.abs(t - lastReadableAt.current) < 120) return;
      lastReadableAt.current = t;

      const stationStatus: Record<string, string | null> = {};
      for (const [station, channel] of timeline.stationBusy) {
        stationStatus[station] = channel.sampleAt(t) ?? null;
      }

      // Band membership is the single source of truth for where an entity paints, so
      // nothing can be rendered twice. Someone seated belongs to their desk's seat band
      // (where the desk front will occlude them); anyone walking belongs to an aisle
      // band chosen by depth. Same for a folder: resting in a desk's tray, or in transit.
      const presentWorkers: string[] = [];
      const bands: Record<string, string> = {};
      for (const [id, state] of timeline.workers) {
        if (!state.present.sampleAt(t)) continue;
        presentWorkers.push(id);
        const at = state.motion.sampleAt(t);
        if (!at) continue;
        const seated = state.station && !state.motion.isMovingAt(t);
        bands[`worker:${id}`] = seated
          ? `${state.station}:seat`
          : aisleBandFor(compiled, at).id;
      }
      for (const [id, state] of timeline.work) {
        const at = state.motion.sampleAt(t);
        if (!at) continue;
        const holder = state.holder.sampleAt(t);
        const resting =
          holder && holder !== 'inbox' && holder !== 'outbox' && !state.motion.isMovingAt(t);
        bands[`work:${id}`] = resting
          ? `${holder}:front`
          : aisleBandFor(compiled, at).id;
      }

      setReadable((previous) => {
        const next = {
          t,
          stationStatus,
          presentWorkers,
          outbox: timeline.outboxCount.sampleAt(t) ?? 0,
          compression: timeline.compression.sampleAt(t) ?? { rate: 1, batched: 0, skippedMs: 0 },
          bands,
        };
        // Cheap equality on the parts that drive layout, to avoid pointless renders.
        const sameBands = JSON.stringify(previous.bands) === JSON.stringify(next.bands);
        const sameStatus =
          JSON.stringify(previous.stationStatus) === JSON.stringify(next.stationStatus);
        const samePresent = previous.presentWorkers.join() === next.presentWorkers.join();
        if (sameBands && sameStatus && samePresent && previous.outbox === next.outbox) {
          return { ...previous, t, compression: next.compression };
        }
        return next;
      });

      onTimeRef.current?.(t, timeline.duration);
    },
    // Deliberately excludes the callbacks: hosts pass inline arrows, so depending on
    // them would give `applyTime` a new identity every render, which re-fires the
    // mount-paint effect, which sets state, which renders again — an infinite loop.
    // They are read through refs instead.
    [timeline, compiled, plan.tile],
  );

  // The animation loop only advances the clock; rendering is applyTime's job.
  useAnimationLoop(
    useCallback(
      (deltaMs: number) => applyTime(clock.current.advance(deltaMs)),
      [applyTime],
    ),
    true,
  );

  // Repaint on mount and whenever the timeline is replaced, so the office shows its
  // opening state immediately instead of an empty floor until the first frame lands.
  // The setState here is the point, not an accident: the office IS an external system
  // being synchronised into React, and there is no first paint without it.
  // eslint-disable-next-line react/react-compiler
  useEffect(() => {
    applyTime(clock.current.time, true);
  }, [applyTime]);

  // Live mode: keep the playhead at the head of the timeline as it grows, so the office
  // always shows the present rather than replaying the backlog from the beginning.
  // eslint-disable-next-line react/react-compiler
  useEffect(() => {
    if (!follow) return;
    clock.current.seek(timeline.duration);
    applyTime(clock.current.time, true);
  }, [follow, timeline.duration, applyTime]);

  // A scrub moves the clock AND repaints, so dragging the scrubber while paused works.
  // eslint-disable-next-line react/react-compiler
  useEffect(() => {
    if (seekMs === null) return;
    clock.current.seek(seekMs);
    applyTime(clock.current.time, true);
  }, [seekMs, applyTime]);

  // --- Camera ---------------------------------------------------------------
  const fullBounds = useMemo(() => planBounds(plan), [plan]);
  const [camera, setCamera] = useState<Bounds>(fullBounds);
  // Reset the camera when the plan changes (switching to the compact mobile layout, say).
  // Adjusted during render rather than in an effect: React re-runs the render immediately
  // with the new value, so a stale camera is never painted.
  const [lastBounds, setLastBounds] = useState<Bounds>(fullBounds);
  if (lastBounds !== fullBounds) {
    setLastBounds(fullBounds);
    setCamera(fullBounds);
  }

  const focusOn = useCallback(
    (at: World | null) => {
      setCamera(at ? focusBounds(plan, at, 2.4) : fullBounds);
    },
    [plan, fullBounds],
  );

  const select = useCallback(
    (next: Selection, at: World | null) => {
      onSelectRef.current?.(next);
      focusOn(next ? at : null);
    },
    [focusOn],
  );

  /**
   * Drill into a department: select it and frame the room rather than a point.
   *
   * The zoom is derived from how much smaller the room is than the whole floor, so a
   * cramped department fills the frame and a sprawling one does not get magnified past
   * usefulness. No new projection maths — the room's own corners, through the same
   * worldToScreen every other thing on this floor goes through.
   */
  const selectRoom = useCallback(
    (room: FloorPlan['rooms'][number]) => {
      const corners = [
        { x: room.origin.x, y: room.origin.y },
        { x: room.origin.x + room.size.w, y: room.origin.y },
        { x: room.origin.x + room.size.w, y: room.origin.y + room.size.h },
        { x: room.origin.x, y: room.origin.y + room.size.h },
      ].map((corner) => worldToScreen(corner, plan.tile));
      const width = Math.max(...corners.map((c) => c.sx)) - Math.min(...corners.map((c) => c.sx));
      const height = Math.max(...corners.map((c) => c.sy)) - Math.min(...corners.map((c) => c.sy));
      const zoom = Math.min(
        3,
        Math.max(1, Math.min(fullBounds.width / (width || 1), fullBounds.height / (height || 1))),
      );
      onSelectRef.current?.({ kind: 'department', id: room.id });
      setCamera(
        focusBounds(
          plan,
          { x: room.origin.x + room.size.w / 2, y: room.origin.y + room.size.h / 2 },
          zoom,
        ),
      );
    },
    [plan, fullBounds],
  );

  // --- Overlay geometry -----------------------------------------------------
  // Project world -> screen -> container pixels, mirroring how the browser fits the
  // viewBox under preserveAspectRatio="xMidYMid meet". Doing the same arithmetic here
  // keeps HTML labels locked to the SVG without reading the DOM every frame.
  const [containerRef, containerSize] = useElementSize<HTMLDivElement>();
  /** Below this the office switches to dots-plus-one-label (PLAN.md A8). */
  const isNarrow = containerSize.width > 0 && containerSize.width < 640;
  const toOverlay = useCallback(
    (at: World) => {
      const { sx, sy } = worldToScreen(at, plan.tile);
      const scale = Math.min(
        containerSize.width / camera.width,
        containerSize.height / camera.height,
      );
      if (!Number.isFinite(scale) || scale <= 0) return { left: 0, top: 0, visible: false };
      const offsetX = (containerSize.width - camera.width * scale) / 2;
      const offsetY = (containerSize.height - camera.height * scale) / 2;
      return {
        left: offsetX + (sx - camera.minX) * scale,
        top: offsetY + (sy - camera.minY) * scale,
        visible: true,
      };
    },
    [camera, containerSize, plan.tile],
  );

  const bandOrder = compiled.bands;
  const stationsById = useMemo(
    () => new Map(plan.stations.map((s) => [s.id, s])),
    [plan.stations],
  );

  /** Entities currently assigned to a given band, for painting in the right layer. */
  const entitiesInBand = useCallback(
    (bandId: string) =>
      Object.entries(readable.bands)
        .filter(([, band]) => band === bandId)
        .map(([key]) => key),
    [readable.bands],
  );

  const anyActive = Object.values(readable.stationStatus).some(Boolean);

  return (
    <div
      ref={containerRef}
      className="office-view"
      style={{ position: 'relative', width: '100%', height: '100%', background: faces.floor }}
    >
      <svg
        viewBox={toViewBox(camera)}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: '100%', display: 'block', transition: `all ${timings.cameraMs}ms ease` }}
        // the interactive desks; the real semantics live in the outline tree below.
        role="img"
        aria-label={`${plan.label}. ${modeLabel}.`}
      >
        {/* Full-bleed backdrop: clicking bare floor deselects and pulls the camera back
            out. A dedicated focusable element rather than a click handler on the <svg>,
            so it is reachable by keyboard like every other target. */}
        <rect
          x={camera.minX}
          y={camera.minY}
          width={camera.width}
          height={camera.height}
          fill="transparent"
          role="button"
          tabIndex={0}
          aria-label="Clear selection"
          onClick={() => select(null, null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
              event.preventDefault();
              select(null, null);
            }
          }}
        />

        {/* Room pads first: the ground everything else sits on. A department can be
            drilled into; the entrance and the waiting area are scenery. Desks paint after
            these, so a click on a desk still wins over the department it sits in. */}
        <g>
          {plan.rooms.map((room) => {
            const stationIds = compiled.roomStations.get(room.id) ?? [];
            // Lit when ANY of its desks is working, not just whichever happens to be first.
            const active = stationIds.some((id) => readable.stationStatus[id]);
            const pad = (
              <RoomPad
                origin={room.origin}
                size={room.size}
                tile={plan.tile}
                active={active}
              />
            );

            if ((room.kind ?? 'department') !== 'department') {
              return (
                <g key={room.id} aria-hidden="true">
                  {pad}
                </g>
              );
            }

            const chosen = selection?.kind === 'department' && selection.id === room.id;
            const corners = [
              { x: room.origin.x, y: room.origin.y },
              { x: room.origin.x + room.size.w, y: room.origin.y },
              { x: room.origin.x + room.size.w, y: room.origin.y + room.size.h },
              { x: room.origin.x, y: room.origin.y + room.size.h },
            ]
              .map((corner) => worldToScreen(corner, plan.tile))
              .map((point) => `${point.sx},${point.sy}`)
              .join(' ');

            return (
              <g
                key={room.id}
                role="button"
                tabIndex={0}
                aria-label={`${room.label} department. ${stationIds.length} ${
                  stationIds.length === 1 ? 'desk' : 'desks'
                }.`}
                style={{ cursor: 'pointer' }}
                onClick={() => selectRoom(room)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectRoom(room);
                  }
                }}
              >
                {pad}
                {chosen ? (
                  /* Graphite, deliberately not violet: violet is only ever allowed to mean
                     "happening right now", and outlining the largest object on screen with
                     it would drown the one signal that matters. */
                  <polygon
                    points={corners}
                    fill="none"
                    stroke={palette.graphite}
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                  />
                ) : null}
              </g>
            );
          })}
          {plan.doors.map((door) => (
            <Door key={door.id} at={door.at} tile={plan.tile} />
          ))}
          <Tray at={plan.inbox.at} tile={plan.tile} />
          <Tray at={plan.outbox.at} tile={plan.tile} count={readable.outbox} />
        </g>

        {/* Depth bands, painted in compiled order. A seated worker sits in the
            `station-seat` band and is therefore occluded by `station-front`. */}
        {bandOrder.map((band) => {
          if (band.kind === 'aisle') {
            return (
              <g key={band.id} data-band={band.id}>
                {entitiesInBand(band.id).map((key) => renderEntity(key))}
              </g>
            );
          }

          const station = band.stationId ? stationsById.get(band.stationId) : undefined;
          if (!station) return null;
          const status = readable.stationStatus[station.id] ?? null;
          const isActive = Boolean(status);

          if (band.kind === 'station-back') {
            return (
              <g key={band.id} data-band={band.id}>
                {/* What makes this department look like itself — declared by the plan,
                    never by the renderer. Behind the desk, so it never hides anyone. */}
                {(station.props ?? [])
                  .filter((prop) => (prop.layer ?? 'back') === 'back')
                  .map((prop, i) => (
                    <Prop
                      key={`${station.id}-prop-${i}`}
                      kind={prop.kind}
                      at={{ x: station.seat.x + prop.at.x, y: station.seat.y + prop.at.y }}
                      tile={plan.tile}
                    />
                  ))}
                <Desk at={station.seat} tile={plan.tile} hot={station.hotDesk} active={isActive} />
              </g>
            );
          }

          if (band.kind === 'station-seat') {
            // Whoever band assignment put here — the permanent desk worker, or a
            // specialist occupying this hot desk.
            return (
              <g key={band.id} data-band={band.id}>
                {entitiesInBand(band.id).map((key) => renderEntity(key))}
              </g>
            );
          }

          // station-front: trays sit in front of the desk and occlude whoever is at it.
          return (
            <g key={band.id} data-band={band.id}>
              <Tray at={station.inTray} tile={plan.tile} />
              <Tray at={station.outTray} tile={plan.tile} />
              {(station.props ?? [])
                .filter((prop) => prop.layer === 'front')
                .map((prop, i) => (
                  <Prop
                    key={`${station.id}-frontprop-${i}`}
                    kind={prop.kind}
                    at={{ x: station.seat.x + prop.at.x, y: station.seat.y + prop.at.y }}
                    tile={plan.tile}
                  />
                ))}
              <g
                role="button"
                tabIndex={0}
                aria-label={`${station.role} desk. ${status ?? 'Standing by'}.`}
                style={{ cursor: 'pointer' }}
                onClick={() => select({ kind: 'station', id: station.id }, station.seat)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    select({ kind: 'station', id: station.id }, station.seat);
                  }
                }}
              >
                {/* Invisible, generously sized hit target. Clicking a thin desk edge is
                    frustrating, and a bigger target costs nothing here. */}
                <rect
                  x={worldToScreen(station.seat, plan.tile).sx - plan.tile.w * 0.5}
                  y={worldToScreen(station.seat, plan.tile).sy - plan.tile.z * 1.6}
                  width={plan.tile.w}
                  height={plan.tile.z * 2.2}
                  fill="transparent"
                />
                {selection?.kind === 'station' && selection.id === station.id ? (
                  <circle
                    cx={worldToScreen(station.seat, plan.tile).sx}
                    cy={worldToScreen(station.seat, plan.tile).sy}
                    r={plan.tile.h * 0.9}
                    fill="none"
                    stroke={live.solid}
                    strokeWidth={2}
                  />
                ) : null}
              </g>
              {/* Folders resting in this desk's trays paint here too, in front of it. */}
              {entitiesInBand(band.id).map((key) => renderEntity(key))}
            </g>
          );
        })}
      </svg>

      {/* HTML label overlay. Labels are HTML so they inherit the app's real type system
          rather than a parallel SVG one that never quite matches. */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
      >
        {plan.stations
          .filter((station) => !station.hotDesk)
          .map((station) => {
            const status = readable.stationStatus[station.id] ?? null;
            // Float the label clear of this department's own furniture, and pull it a
            // little toward the viewer so it sits over open floor rather than over the
            // shelves behind the desk. A fixed height worked until departments got their
            // own furniture; a rack is more than twice the height of a paper stack, so
            // the clearance has to come from what this desk actually has on it.
            const point = toOverlay(labelAnchorFor(station));
            if (!point.visible) return null;
            const isActive = Boolean(status);
            const isSelected = selection?.kind === 'station' && selection.id === station.id;

            // On a narrow screen, six labels overlap into an unreadable pile and destroy
            // the diorama. Only the desk that is actually doing something (or the one the
            // viewer picked) keeps its label; the rest collapse to a dot. Nothing is
            // hidden that the viewer asked for — a tap still brings the label back.
            if (isNarrow && !isActive && !isSelected) {
              return (
                <div
                  key={station.id}
                  className="office-dot"
                  style={{ left: point.left, top: point.top }}
                />
              );
            }

            return (
              <div
                key={station.id}
                className={`office-label${isActive ? ' is-active' : ''}`}
                style={{ left: point.left, top: point.top }}
              >
                <span className="office-label-role">{station.role}</span>
                {/* The literal action, verbatim from the producer. Never an invented
                    inner monologue — the office reports, it does not narrate. */}
                <span className="office-label-status">{status ?? 'Standing by'}</span>
              </div>
            );
          })}
      </div>

      {/* I4: whenever time is compressed or items are batched, say so. A compromise
          stated out loud is information; unstated, it would be a lie. */}
      {readable.compression.rate !== 1 ||
      readable.compression.batched > 0 ||
      readable.compression.skippedMs > 0 ? (
        <output className="office-compression">
          {[
            readable.compression.rate !== 1 ? `×${readable.compression.rate} time-compressed` : null,
            readable.compression.skippedMs > 0
              ? `${describeSkipped(readable.compression.skippedMs)} of waiting skipped`
              : null,
            readable.compression.batched > 0 ? `${readable.compression.batched} batched` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </output>
      ) : null}

      <div className="office-mode-stamp">{modeLabel}</div>

      {/* The accessibility outline is not a courtesy bolted on the side: this product's
          whole premise is making agentic work legible, so an office a screen reader can
          walk through IS the product. */}
      <OfficeOutline
        plan={plan}
        compiled={compiled}
        stationStatus={readable.stationStatus}
        presentWorkers={readable.presentWorkers}
        workers={timeline.workers}
        outbox={readable.outbox}
        anyActive={anyActive}
        selection={selection ?? null}
        onSelectStation={(id) => {
          const seat = plan.stations.find((station) => station.id === id)?.seat ?? null;
          select({ kind: 'station', id }, seat);
        }}
        onSelectRoom={selectRoom}
      />
    </div>
  );

  /** Render a moving entity into whichever band it currently occupies. */
  function renderEntity(key: string) {
    const [kind, id] = splitKey(key);

    if (kind === 'work') {
      const state = timeline.work.get(id);
      if (!state) return null;
      const moving = state.motion.isMovingAt(readable.t);
      // Whether this folder is part of a group; the group's *size* is stated once in the
      // compression pill rather than stamped on every folder.
      const batched = Boolean(state.batched.sampleAt(readable.t));
      return (
        <g
          key={key}
          ref={registerNode(key)}
          role="button"
          tabIndex={0}
          aria-label={`${state.label}. ${moving ? 'In transit' : 'At a desk'}.`}
          style={{ cursor: 'pointer' }}
          onClick={() => select({ kind: 'work', id }, state.motion.sampleAt(readable.t) ?? null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              select({ kind: 'work', id }, state.motion.sampleAt(readable.t) ?? null);
            }
          }}
        >
          {/* Drawn at the origin; the loop positions the group. */}
          <Folder at={{ x: 0, y: 0 }} tile={plan.tile} moving={moving} batched={batched} />
        </g>
      );
    }

    const state = timeline.workers.get(id);
    if (!state) return null;
    const moving = state.motion.isMovingAt(readable.t);
    const status = state.status.sampleAt(readable.t);
    return (
      <g
        key={key}
        ref={registerNode(key)}
        role="button"
        tabIndex={0}
        aria-label={`${state.role}${state.assignment ? `, ${state.assignment}` : ''}. ${status ?? 'Standing by'}.`}
        style={{ cursor: 'pointer' }}
        onClick={() => select({ kind: 'worker', id }, state.motion.sampleAt(readable.t) ?? null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select({ kind: 'worker', id }, state.motion.sampleAt(readable.t) ?? null);
          }
        }}
      >
        <Worker
          at={{ x: 0, y: 0 }}
          tile={plan.tile}
          specialist={state.kind === 'specialist'}
          active={Boolean(status)}
          moving={moving}
        />
      </g>
    );
  }
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}

/**
 * A parallel semantic tree of the office, for screen readers.
 *
 * Visually hidden, but a genuine structural description: rooms, their desks, and what
 * each desk is currently doing. Someone who cannot see the diorama should still be able
 * to answer "what is happening right now?", which is the only question this product
 * exists to answer.
 */
function OfficeOutline({
  plan,
  compiled,
  stationStatus,
  presentWorkers,
  workers,
  outbox,
  anyActive,
  selection,
  onSelectStation,
  onSelectRoom,
}: {
  plan: FloorPlan;
  compiled: CompiledPlan;
  stationStatus: Record<string, string | null>;
  presentWorkers: string[];
  workers: ScheduleResult['workers'];
  outbox: number;
  selection: Selection;
  onSelectStation: (id: StationId) => void;
  onSelectRoom: (room: FloorPlan['rooms'][number]) => void;
  anyActive: boolean;
}) {
  return (
    <div className="office-outline">
      <h3>{plan.label}</h3>
      <p aria-live="polite">
        {anyActive ? 'Work is in progress.' : 'The office is idle.'} {outbox} finished
        {outbox === 1 ? ' item' : ' items'} in the outbox.
      </p>
      {/* Grouped by department, every node a real button, so the drill-down the mouse
          gets is reachable by keyboard and announced. Statuses are the same strings the
          desks show — a second view of the same facts, never a summary of them. */}
      <ul>
        {plan.rooms
          .filter((room) => (room.kind ?? 'department') === 'department')
          .map((room) => {
            const desks = (compiled.roomStations.get(room.id) ?? [])
              .map((id) => plan.stations.find((station) => station.id === id))
              .filter((station): station is Station => Boolean(station) && !station!.hotDesk);
            if (desks.length === 0) return null;
            const live = desks.filter((desk) => stationStatus[desk.id]).length;
            return (
              <li key={room.id}>
                <button
                  type="button"
                  aria-current={
                    selection?.kind === 'department' && selection.id === room.id ? 'true' : undefined
                  }
                  onClick={() => onSelectRoom(room)}
                >
                  {room.label} department, {desks.length} {desks.length === 1 ? 'desk' : 'desks'},{' '}
                  {live > 0 ? `${live} working` : 'standing by'}
                </button>
                <ul>
                  {desks.map((desk) => (
                    <li key={desk.id}>
                      <button
                        type="button"
                        aria-current={
                          selection?.kind === 'station' && selection.id === desk.id
                            ? 'true'
                            : undefined
                        }
                        onClick={() => onSelectStation(desk.id)}
                      >
                        <strong>{desk.role}</strong>: {stationStatus[desk.id] ?? 'Standing by'}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
      </ul>
      {presentWorkers.length > 0 ? (
        <>
          <h4>Visiting specialists</h4>
          <ul>
            {presentWorkers
              .map((id) => workers.get(id))
              .filter((worker) => worker && worker.kind === 'specialist')
              .map((worker) => (
                <li key={worker!.id}>
                  {worker!.role}
                  {worker!.assignment ? `: ${worker!.assignment}` : ''}
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export { palette as officePalette };

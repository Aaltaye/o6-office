'use client';
/**
 * office-view/three/OfficeStage — the office as a real 3D scene.
 *
 * A drop-in alternative to the SVG `OfficeView`, with the same props and the same
 * behaviour. This is what the event contract bought: `core/` is DOM-free and turns events
 * into positions over time, so a completely different renderer consumes exactly the same
 * timeline. The workflow, the bridge and every honesty rule are untouched.
 *
 * What carries over deliberately:
 *  - **Labels stay HTML.** Projected from 3D each frame, but still real DOM text, so they
 *    keep the app's type system and stay crisp. Text is the thing WebGL is worst at, and
 *    the literal status label is a first-class requirement here.
 *  - **The accessibility outline is unchanged.** It never depended on the renderer, and a
 *    3D canvas is opaque to a screen reader, so it matters more here, not less.
 *  - **The camera does not chase the action.** Auto-panning to whatever is hot is the
 *    single strongest "this is a game" signal. It orbits gently and moves on a click.
 *  - **Violet still means only "happening right now".**
 *
 * What is genuinely different: depth, soft shadows, and figures with volume. Those are
 * the reason to do this at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import type { FloorPlan, OfficeEvent, Station, World } from '../core/types.ts';
import { compileFloorPlan, type CompiledPlan } from '../core/plan.ts';
import { SimClock, describeSkipped } from '../core/timeline.ts';
import { schedule, type ScheduleResult, type SchedulerOptions } from '../core/scheduler.ts';
import { PROP_SHAPES } from '../art/theme.ts';
import { setWorkerDormant } from './stage-scene.ts';
import { useAnimationLoop, useElementSize, usePrefersReducedMotion } from '../react/useAnimationLoop.ts';
import type { Selection } from '../react/OfficeView.tsx';
import {
  deCollideLabels,
  labelModeFor,
  LABEL_BOX,
  LABEL_BOX_COMPACT,
  addLighting,
  deskCentre,
  buildFolder,
  buildStaticScene,
  buildWorker,
  colorForWorker,
  createMaterials,
  planCentre,
  planRadius,
  toScene,
} from './stage-scene.ts';

export type OfficeStageProps = {
  plan: FloorPlan;
  /**
   * Finished agents the viewer has cleared away.
   *
   * A view filter and nothing more: it hides a record, and never touches the event stream,
   * the timeline, the operations log or any total. What was discarded is still counted and
   * still stated — see the Inspector's cleared line — because a discard that silently
   * shrank what the office reports would be the same class of lie as a truncated list that
   * does not say it is truncated.
   */
  dismissed?: ReadonlySet<string>;
  events: readonly OfficeEvent[];
  modeLabel: string;
  playing?: boolean;
  speed?: number;
  seekMs?: number | null;
  follow?: boolean;
  /**
   * Restart a finished recording instead of freezing on its last frame.
   *
   * For an ambient demo — the landing hero — stopping dead is worse than repeating: a
   * visitor who arrives a minute late sees a still image and concludes it is one.
   */
  loop?: boolean;
  /**
   * Whether selecting something moves the camera to it. Default true.
   *
   * The landing hero turns this off: there, selection exists so a viewer can tap a dot and
   * read the label back, not so the demo can rearrange itself under their finger.
   */
  focusOnSelect?: boolean;
  onTime?: (ms: number, duration: number) => void;
  onSelect?: (selection: Selection) => void;
  selection?: Selection;
  schedulerOptions?: Partial<SchedulerOptions>;
};

/** Clear air between the tallest thing at a desk and its floating label. */
const LABEL_CLEARANCE = 0.55;

function labelAnchorFor(station: Station): World {
  const behind = (station.props ?? []).filter((prop) => (prop.layer ?? 'back') === 'back');
  const tallest = behind.reduce((max, prop) => Math.max(max, PROP_SHAPES[prop.kind].h), 0);
  // Above the desk, not above the person: the desk is what the label names.
  const desk = deskCentre(station.seat, station.facing);
  return { x: desk.x, y: desk.y, z: Math.max(1.6, tallest + LABEL_CLEARANCE) };
}

/** Stable identity, so a component with no discards does not re-render every frame. */
const EMPTY_DISMISSED: ReadonlySet<string> = new Set();

export function OfficeStage({
  plan,
  dismissed = EMPTY_DISMISSED,
  events,
  modeLabel,
  playing = true,
  speed = 1,
  seekMs = null,
  follow = false,
  focusOnSelect = true,
  loop = false,
  onTime,
  onSelect,
  selection = null,
  schedulerOptions,
}: OfficeStageProps) {
  const reducedMotion = usePrefersReducedMotion();
  const compiled: CompiledPlan = useMemo(() => compileFloorPlan(plan), [plan]);
  const timeline: ScheduleResult = useMemo(
    () => schedule(events, compiled, { ...schedulerOptions, reducedMotion }),
    [events, compiled, schedulerOptions, reducedMotion],
  );

  useEffect(() => {
    if (timeline.violations.length > 0) {
      console.error('[office-stage] scheduling invariants violated:', timeline.violations);
    }
  }, [timeline.violations]);

  const [mountRef, size] = useElementSize<HTMLDivElement>();
  const clock = useRef<SimClock>(null as unknown as SimClock);
  if (clock.current === null) clock.current = new SimClock(timeline.duration);

  const onTimeRef = useRef(onTime);
  const onSelectRef = useRef(onSelect);
  // The click handler is deliberately dependency-free so it never re-binds mid-drag; it
  // reads the plan through a ref rather than closing over it.
  const planRef = useRef(plan);
  useEffect(() => {
    onTimeRef.current = onTime;
    onSelectRef.current = onSelect;
    planRef.current = plan;
  });

  /** Everything three.js owns. Kept in a ref: React must never re-render for a frame. */
  const stage = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    workers: Map<string, THREE.Group>;
    folders: Map<string, THREE.Mesh>;
    liveMeshes: Map<string, THREE.Mesh[]>;
    materials: ReturnType<typeof createMaterials>;
    pickables: THREE.Object3D[];
    centre: THREE.Vector3;
    radius: number;
    /**
     * How far the people reach, as opposed to how far the furniture reaches.
     *
     * Measured every frame in applyTime and read by the camera, so a burst of concurrent
     * agents standing outside their department widens the shot rather than working
     * off-screen. Only ever widens; the plan's own extent is the floor.
     */
    crowdRadius: number;
  } | null>(null);

  /** Text the viewer reads. Updated a few times a second, never per frame. */
  const [readable, setReadable] = useState(() => ({
    t: 0,
    stationStatus: {} as Record<string, string | null>,
    labels: {} as Record<string, { left: number; top: number; visible: boolean; active?: boolean; collapsed?: boolean }>,
    presentWorkers: [] as string[],
    outbox: 0,
    /** I4: what the viewer must be told about how time is being handled, right now. */
    compression: { rate: 1, batched: 0, skippedMs: 0 },
  }));
  const lastReadableAt = useRef(0);

  // --- build the scene once per plan -----------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Physically-ish correct tone mapping. Without it the porcelain blows out and the
    // whole office reads as flat white paper rather than a lit room.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#E9E4DA');
    // A little haze so the far wall does not read as a hard cut-out.
    scene.fog = new THREE.Fog('#E9E4DA', 26, 62);
    addLighting(scene, plan);

    const materials = createMaterials();
    const { root, liveMeshes } = buildStaticScene(plan, materials);
    scene.add(root);

    const centre = planCentre(plan);
    const radius = planRadius(plan);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);

    stage.current = {
      renderer,
      scene,
      camera,
      workers: new Map(),
      folders: new Map(),
      liveMeshes,
      materials,
      // Desks are the click targets; the meshes are already in the scene.
      pickables: [...liveMeshes.values()].flat(),
      centre,
      radius,
      /** Updated every frame from where people actually are; see applyTime. */
      crowdRadius: 0,
    };

    return () => {
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      stage.current = null;
    };
  }, [plan, mountRef]);

  // --- keep the drawing buffer matched to the element -------------------------
  useEffect(() => {
    const current = stage.current;
    if (!current || size.width === 0 || size.height === 0) return;
    current.renderer.setSize(size.width, size.height, false);
    current.camera.aspect = size.width / size.height;
    current.camera.updateProjectionMatrix();
  }, [size]);

  useEffect(() => {
    if (playing) clock.current.play();
    else clock.current.pause();
  }, [playing]);

  useEffect(() => {
    clock.current.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    clock.current.extend(timeline.duration);
    /*
     * Re-assert the intent. The clock stops itself the moment it reaches the end, and in a
     * LIVE run it reaches the end constantly — duration starts near zero and grows one
     * event at a time, so without this the clock dies on the first frame and never moves
     * again. Everything then jumps between positions instead of travelling, which reads as
     * teleporting and is exactly what the office is not supposed to do.
     */
    if (playing) clock.current.play();
  }, [timeline.duration, playing]);

  /**
   * Below this the office switches to dots-plus-live-labels. Measured on the stage's own
   * container rather than the viewport, because this canvas is often one column of a
   * wider page — the crowding depends on the box the labels are actually drawn in.
   */
  const isNarrow = size.width > 0 && size.width < 640;

  /** Project a world point to overlay pixels, so an HTML label can sit on it. */
  const project = useCallback(
    (at: World) => {
      const current = stage.current;
      if (!current || size.width === 0) return { left: 0, top: 0, visible: false };
      const point = toScene(at).project(current.camera);
      return {
        left: ((point.x + 1) / 2) * size.width,
        top: ((1 - point.y) / 2) * size.height,
        // Behind the camera, or outside the frustum: do not draw a label for it.
        visible: point.z < 1 && Math.abs(point.x) < 1.4 && Math.abs(point.y) < 1.4,
      };
    },
    [size],
  );

  /**
   * Render the office at time `t`.
   *
   * Same split as the SVG renderer: object transforms every frame, text on a throttle.
   */
  /** True once a finished recording has been restarted at least once, for the stamp. */
  const loopedRef = useRef(false);

  const applyTime = useCallback(
    (t: number, force = false) => {
      const current = stage.current;
      if (!current) return;
      const { scene, workers, folders, materials } = current;
      /** The furthest anyone stands from the middle of the office, this frame. */
      let crowd = 0;

      // --- the cast, which changes only when someone joins or leaves ---
      for (const [id, state] of timeline.workers) {
        const present = state.present.sampleAt(t) ?? false;
        /*
         * A finished agent stays at the desk it used so its work can still be reviewed,
         * but it is drawn as a record rather than as a colleague: no identity colour, no
         * shadow, and — through `stationStatus` — no caption claiming an action. The
         * shadow matters most. A contact shadow is the claim that something is standing
         * there; without one the figure reads as a marker on the floor, which is what it is.
         */
        const record = dismissed.has(id) ? null : (state.departed.sampleAt(t) ?? null);
        const onFloor = present || Boolean(record);
        let figure = workers.get(id);
        if (!figure && onFloor) {
          figure = buildWorker(colorForWorker(id));
          workers.set(id, figure);
          scene.add(figure);
          /*
           * A person is only pickable once they exist, which is exactly right: the cast is
           * built from the stream, so you can never click someone who is not on the floor.
           * Every mesh in the figure carries the id, because a raycast hits a head or an
           * arm, not the group.
           */
          figure.traverse((part) => {
            part.userData.workerId = id;
          });
          current.pickables.push(figure);
        }
        if (!figure) continue;
        figure.visible = onFloor;
        /*
         * Raycasting tests layers, never `visible`, so a hidden figure still swallows
         * clicks unless its layers go with it. A discarded record must be unclickable as
         * well as unseen.
         */
        if (onFloor) figure.layers.enableAll();
        else figure.layers.disableAll();
        setWorkerDormant(figure, materials, Boolean(record) && !present);
        const at = state.motion.sampleAt(t);
        if (at) figure.position.set(at.x, 0, at.y);
        /*
         * How far the people actually reach, which is not the same as how far the FURNITURE
         * reaches. A department has three desks; a burst of concurrent agents stands in it
         * beyond them, and past a certain crowd that spills outside the room. The camera
         * frames the plan, so without this the office would calmly show an empty floor
         * while a dozen agents worked just outside the shot.
         */
        if (at && onFloor) {
          crowd = Math.max(crowd, Math.hypot(at.x - current.centre.x, at.y - current.centre.z));
        }
      }
      // Only widens the shot; it never crops one. The plan's own extent is the floor.
      current.crowdRadius = crowd;

      for (const [id, state] of timeline.work) {
        const at = state.motion.sampleAt(t);
        let folder = folders.get(id);
        if (!folder && at) {
          folder = buildFolder();
          folders.set(id, folder);
          scene.add(folder);
        }
        if (!folder) continue;
        folder.visible = Boolean(at);
        if (at) {
          const moving = state.motion.isMovingAt(t);
          // Carried at chest height while travelling, set down on arrival. A folder that
          // floats at a constant height reads as a cursor, not an object.
          folder.position.set(at.x, moving ? 0.62 : 0.48, at.y);
          folder.rotation.y = moving ? Math.sin(t / 300) * 0.12 : 0;
        }
      }

      // --- desks light up when they are working ---
      for (const [station, channel] of timeline.stationBusy) {
        const busy = Boolean(channel.sampleAt(t));
        for (const meshItem of current.liveMeshes.get(station) ?? []) {
          meshItem.material = busy ? materials.live : materials.desk;
        }
      }

      current.renderer.render(scene, current.camera);

      // --- throttled: text a human reads ---
      if (!force && Math.abs(t - lastReadableAt.current) < 120) return;
      lastReadableAt.current = t;

      const stationStatus: Record<string, string | null> = {};
      const labels: Record<
        string,
        { left: number; top: number; visible: boolean; active?: boolean; collapsed?: boolean }
      > = {};
      for (const [station, channel] of timeline.stationBusy) {
        stationStatus[station] = channel.sampleAt(t) ?? null;
      }
      for (const station of plan.stations) {
        if (station.hotDesk) continue;
        /*
         * A department is captioned once, not once per desk.
         *
         * Every desk used to be a department, so labelling all of them was labelling the
         * departments. Now a department owns several desks and captioning each of them
         * writes "Operations / Standing by" three times over three empty desks — noise
         * that says nothing, and it crowds out the labels that do. A satellite earns a
         * caption only when it has something of its own to report: somebody working at it.
         */
        const active = Boolean(stationStatus[station.id]);
        if (station.satellite && !active) continue;
        labels[station.id] = {
          ...project(labelAnchorFor(station)),
          // Placement needs to know which labels carry a literal action, so those can be
          // placed first and never moved.
          active,
        };
      }
      // Desks that line up along the camera's view direction project to labels sitting on
      // top of each other. Separating them is a legibility fix in screen space only.
      const spacedLabels = deCollideLabels(labels, {
        box: isNarrow ? LABEL_BOX_COMPACT : LABEL_BOX,
        // The overlay clips, so placement has to know where the frame ends.
        frameHeight: size.height,
      });

      const presentWorkers: string[] = [];
      for (const [id, state] of timeline.workers) {
        if (state.present.sampleAt(t)) presentWorkers.push(id);
      }

      setReadable({
        t,
        stationStatus,
        labels: spacedLabels,
        presentWorkers,
        outbox: timeline.outboxCount.sampleAt(t) ?? 0,
        compression: timeline.compression.sampleAt(t) ?? { rate: 1, batched: 0, skippedMs: 0 },
      });
      onTimeRef.current?.(t, timeline.duration);
    },
    [timeline, plan.stations, project, isNarrow, size.height, dismissed],
  );

  // --- camera ---------------------------------------------------------------
  /** Where the camera should settle. Derived from the host's selection rather than
   *  stored, so the two can never disagree about which desk is being looked at. */
  const focus = useMemo<{ at: World; distance: number } | null>(() => {
    // Selection still happens — a label still comes back — the camera simply stays put.
    if (!focusOnSelect) return null;
    if (selection?.kind === 'station') {
      const seat = plan.stations.find((s) => s.id === selection.id)?.seat;
      return seat ? { at: seat, distance: 0 } : null;
    }
    if (selection?.kind === 'worker') {
      const at = timeline.workers.get(selection.id)?.motion.sampleAt(readable.t);
      return at ? { at, distance: 0 } : null;
    }
    if (selection?.kind === 'department') {
      const room = plan.rooms.find((candidate) => candidate.id === selection.id);
      if (!room) return null;
      // Frame the room itself rather than the whole floor. Deliberately not routed
      // through planRadius, whose 8-unit floor would zoom a small department back out to
      // roughly the size of the building.
      const extent = Math.max(room.size.w, room.size.h) / 2;
      return {
        at: { x: room.origin.x + room.size.w / 2, y: room.origin.y + room.size.h / 2 },
        distance: Math.max(extent * 3.4, 6),
      };
    }
    return null;
  }, [selection, plan.stations, plan.rooms, focusOnSelect, timeline.workers, readable.t]);
  const cameraState = useRef({ angle: -0.9, target: new THREE.Vector3(), distance: 0 });

  useAnimationLoop(
    useCallback(
      (deltaMs: number) => {
        const current = stage.current;
        if (!current) return;

        // The camera drifts, very slowly, and never chases. Enough parallax to read as a
        // real space; not enough to feel like a game camera following the action.
        const cam = cameraState.current;
        if (cam.distance === 0) {
          cam.distance = current.radius * 2.15;
          cam.target.copy(current.centre);
        }
        const wantTarget = focus
          ? new THREE.Vector3(focus.at.x, 0.6, focus.at.y)
          : current.centre.clone();
        // A department carries its own framing distance; a desk keeps the close-in one.
        /*
         * The office expands and contracts with the crowd.
         *
         * `radius` is the furniture; `crowdRadius` is where people have actually got to.
         * Twenty agents in one department stand well outside its room, and the shot has to
         * grow to include them or the office is quietly under-reporting how much is going
         * on. It shrinks back the same way as they finish and are cleared — through the
         * same 0.06 lerp below, so it reads as the room breathing rather than a cut.
         */
        const occupied = Math.max(current.radius, current.crowdRadius + 1.5);
        const wantDistance = focus
          ? focus.distance > 0
            ? focus.distance
            : current.radius * 1.1
          : occupied * 2.15;

        if (!reducedMotion) cam.angle += deltaMs * 0.000018;
        cam.target.lerp(wantTarget, 0.06);
        cam.distance += (wantDistance - cam.distance) * 0.06;

        current.camera.position.set(
          cam.target.x + Math.cos(cam.angle) * cam.distance * 0.78,
          cam.distance * 0.62,
          cam.target.z + Math.sin(cam.angle) * cam.distance * 0.78,
        );
        current.camera.lookAt(cam.target);

        const t = clock.current.advance(deltaMs);
        /*
         * A finished recording restarts rather than freezing on its last frame. Only for
         * an ambient demo that opted in: a visitor who arrives after the run has ended
         * would otherwise see a still image and reasonably conclude it is one.
         *
         * This is a repeat, not a claim of new work — nothing about the events changes,
         * and the stamp still says it is a recording.
         */
        if (loop && t >= clock.current.duration && clock.current.duration > 0) {
          loopedRef.current = true;
          clock.current.seek(0);
          clock.current.play();
        }
        applyTime(t);
      },
      [applyTime, focus, reducedMotion, loop],
    ),
    true,
  );

  // First paint, and repaint on any external seek — a scrub must repaint even while
  // paused, exactly as in the SVG renderer.
  // eslint-disable-next-line react/react-compiler
  useEffect(() => {
    applyTime(clock.current.time, true);
  }, [applyTime]);

  // eslint-disable-next-line react/react-compiler
  useEffect(() => {
    if (seekMs === null) return;
    clock.current.seek(seekMs);
    applyTime(clock.current.time, true);
  }, [seekMs, applyTime]);

  // eslint-disable-next-line react/react-compiler
  useEffect(() => {
    if (!follow) return;
    clock.current.seek(timeline.duration);
    applyTime(clock.current.time, true);
  }, [follow, timeline.duration, applyTime]);

  // --- picking --------------------------------------------------------------
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const current = stage.current;
      if (!current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, current.camera);
      /*
       * Finest thing wins. A person standing at a desk is a more specific answer to "what
       * did I just click" than the desk, which is more specific than the department.
       *
       * `true` for recursive: a figure is a group of meshes, and a ray hits a head, not
       * the group.
       */
      const hit = raycaster.intersectObjects(current.pickables, true)[0];
      if (hit) {
        const workerId = hit.object.userData?.workerId;
        if (typeof workerId === 'string') {
          onSelectRef.current?.({ kind: 'worker', id: workerId });
          return;
        }
        for (const [stationId, meshes] of current.liveMeshes) {
          if (!meshes.includes(hit.object as THREE.Mesh)) continue;
          onSelectRef.current?.({ kind: 'station', id: stationId });
          return;
        }
      }

      /*
       * No desk under the pointer, so fall back to the floor itself: which department did
       * the click land in? Intersecting the ground plane rather than adding pick geometry
       * means departments need no meshes of their own and the whole floor of a department
       * is a target, not just its pad. toScene maps plan (x, y) to three (x, z), so the
       * inverse reads z back as the plan's y.
       */
      const floor = new THREE.Vector3();
      const onFloor = raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        floor,
      );
      if (!onFloor) {
        onSelectRef.current?.(null);
        return;
      }
      const room = planRef.current.rooms.find(
        (candidate) =>
          (candidate.kind ?? 'department') === 'department' &&
          floor.x >= candidate.origin.x &&
          floor.x <= candidate.origin.x + candidate.size.w &&
          floor.z >= candidate.origin.y &&
          floor.z <= candidate.origin.y + candidate.size.h,
      );
      onSelectRef.current?.(room ? { kind: 'department', id: room.id } : null);
    },
    [],
  );

  const anyActive = Object.values(readable.stationStatus).some(Boolean);

  return (
    <div
      className={`office-view office-stage${isNarrow ? ' is-narrow' : ''}`}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {/* The canvas. Click handling lives on the wrapper so an empty-floor click can
          deselect, which a canvas alone cannot express. */}
      <div
        ref={mountRef}
        style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onSelectRef.current?.(null);
          }
        }}
        role="presentation"
      />

      {/* Labels are HTML, projected from the 3D scene each throttled tick. Text is what
          WebGL is worst at, and the literal status line is a first-class requirement. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {plan.stations
          .filter((station) => !station.hotDesk)
          .map((station) => {
            const point = readable.labels[station.id];
            if (!point?.visible) return null;
            const status = readable.stationStatus[station.id] ?? null;
            /* "Selected" covers the department too. A dot is drawn at the label's anchor,
               which floats above the desk, so tapping one raycasts past the desk mesh and
               lands on the floor — which selects the department it sits in. Revealing that
               department's desk labels is what makes the dot rule's promise ("a tap brings
               the label back") actually true on a phone. */
            const isSelected =
              (selection?.kind === 'station' && selection.id === station.id) ||
              (selection?.kind === 'department' &&
                selection.id === compiled.roomOf.get(station.id));

            /* Two ways a desk ends up as a dot: the stage is too narrow to carry six
               labels, or placement could not fit this one inside the frame. Both only ever
               happen to a label that would have read "Standing by" — text this renderer
               wrote, not a producer. A live status is never collapsed, and a tap brings
               the label back. */
            /* Selection wins over both reasons a desk becomes a dot. Collapsing is an
               automatic decision made to save room; asking for a specific desk is not, and
               an explicit request must never be overruled by a layout heuristic. It may
               now overlap a neighbour — that is the correct trade when someone has asked
               for exactly this one. */
            if (!isSelected && (point.collapsed || labelModeFor({ isNarrow, status, isSelected }) === 'dot')) {
              /* The dot is its own tap target rather than relying on the raycast beneath
                 it: a dot sits at the label's anchor, which floats ABOVE the desk, so a ray
                 cast through it passes over the desk and lands on floor further back —
                 often outside the room entirely. Tapping the thing you can see should
                 select the thing it stands for.

                 pointer-events is re-enabled on the dot alone; the rest of the overlay
                 stays inert so it never steals clicks from the canvas. It remains inside
                 the aria-hidden overlay deliberately — the screen-reader path is the
                 outline, and announcing every desk twice would be worse than not at all. */
              return (
                <button
                  key={station.id}
                  type="button"
                  /* Deliberately out of the tab order: the outline is the keyboard and
                     screen-reader path, and this whole overlay is aria-hidden. A real
                     button rather than a div so a pointer or touch gets native behaviour. */
                  tabIndex={-1}
                  aria-label={`${station.role} desk. ${status ?? 'Standing by'}.`}
                  className="office-dot"
                  style={{ left: point.left, top: point.top, pointerEvents: 'auto' }}
                  onClick={() => onSelectRef.current?.({ kind: 'station', id: station.id })}
                />
              );
            }

            return (
              <div
                key={station.id}
                className={`office-label${status ? ' is-active' : ''}`}
                style={{ left: point.left, top: point.top }}
              >
                <span className="office-label-role">{station.role}</span>
                <span className="office-label-status">{status ?? 'Standing by'}</span>
              </div>
            );
          })}
      </div>

      {/* I4: whenever time is compressed, sped up, or items are batched, say so. A
          compromise stated out loud is information; unstated it would be a lie — and this
          is the renderer people actually watch, so it is the one that has to say it.

          Playback speed belongs here too: the landing hero runs a 23-minute session in
          under a minute, and a viewer who is not told that is being misled about pace even
          though every event is real and in order. */}
      {readable.compression.rate !== 1 ||
      readable.compression.batched > 0 ||
      readable.compression.skippedMs > 0 ||
      speed !== 1 ? (
        <output className="office-compression">
          {[
            readable.compression.rate !== 1 ? `×${readable.compression.rate} time-compressed` : null,
            speed !== 1 ? `×${speed} speed` : null,
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

      {/* A canvas is opaque to a screen reader, so the parallel outline matters more
          here than it did in SVG, not less. */}
      <div className="office-outline">
        <h3>{plan.label}</h3>
        <p aria-live="polite">
          {anyActive ? 'Work is in progress.' : 'The office is idle.'} {readable.outbox} finished
          {readable.outbox === 1 ? ' item' : ' items'} in the outbox.
        </p>
        {/* Grouped by department, and every node is a real button, so the drill-down the
            mouse gets is reachable by keyboard and announced by a screen reader. Statuses
            are the same strings the desks show — the outline is a second view of the same
            facts, never a summary of them. */}
        <ul>
          {plan.rooms
            .filter((room) => (room.kind ?? 'department') === 'department')
            .map((room) => {
              const deskIds = compiled.roomStations.get(room.id) ?? [];
              const desks = deskIds
                .map((id) => plan.stations.find((station) => station.id === id))
                .filter((station) => station && !station.hotDesk);
              if (desks.length === 0) return null;
              const live = desks.filter((desk) => readable.stationStatus[desk!.id]).length;
              const chosen = selection?.kind === 'department' && selection.id === room.id;
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    aria-current={chosen ? 'true' : undefined}
                    onClick={() => onSelectRef.current?.({ kind: 'department', id: room.id })}
                  >
                    {room.label} department, {desks.length}{' '}
                    {desks.length === 1 ? 'desk' : 'desks'},{' '}
                    {live > 0 ? `${live} working` : 'standing by'}
                  </button>
                  <ul>
                    {desks.map((desk) => (
                      <li key={desk!.id}>
                        <button
                          type="button"
                          aria-current={
                            selection?.kind === 'station' && selection.id === desk!.id
                              ? 'true'
                              : undefined
                          }
                          onClick={() =>
                            onSelectRef.current?.({ kind: 'station', id: desk!.id })
                          }
                        >
                          <strong>{desk!.role}</strong>:{' '}
                          {readable.stationStatus[desk!.id] ?? 'Standing by'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
        </ul>
        <p>{readable.presentWorkers.length} on the floor.</p>
      </div>
    </div>
  );
}

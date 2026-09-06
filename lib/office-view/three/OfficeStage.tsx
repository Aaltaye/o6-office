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
import { SimClock } from '../core/timeline.ts';
import { schedule, type ScheduleResult, type SchedulerOptions } from '../core/scheduler.ts';
import { PROP_SHAPES } from '../art/theme.ts';
import { useAnimationLoop, useElementSize, usePrefersReducedMotion } from '../react/useAnimationLoop.ts';
import type { Selection } from '../react/OfficeView.tsx';
import {
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
  events: readonly OfficeEvent[];
  modeLabel: string;
  playing?: boolean;
  speed?: number;
  seekMs?: number | null;
  follow?: boolean;
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

export function OfficeStage({
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
  useEffect(() => {
    onTimeRef.current = onTime;
    onSelectRef.current = onSelect;
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
  } | null>(null);

  /** Text the viewer reads. Updated a few times a second, never per frame. */
  const [readable, setReadable] = useState(() => ({
    t: 0,
    stationStatus: {} as Record<string, string | null>,
    labels: {} as Record<string, { left: number; top: number; visible: boolean }>,
    presentWorkers: [] as string[],
    outbox: 0,
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
  }, [timeline.duration]);

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
  const applyTime = useCallback(
    (t: number, force = false) => {
      const current = stage.current;
      if (!current) return;
      const { scene, workers, folders, materials } = current;

      // --- the cast, which changes only when someone joins or leaves ---
      for (const [id, state] of timeline.workers) {
        const present = state.present.sampleAt(t) ?? false;
        let figure = workers.get(id);
        if (!figure && present) {
          figure = buildWorker(colorForWorker(id));
          workers.set(id, figure);
          scene.add(figure);
        }
        if (!figure) continue;
        figure.visible = present;
        const at = state.motion.sampleAt(t);
        if (at) figure.position.set(at.x, 0, at.y);
      }

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
      const labels: Record<string, { left: number; top: number; visible: boolean }> = {};
      for (const [station, channel] of timeline.stationBusy) {
        stationStatus[station] = channel.sampleAt(t) ?? null;
      }
      for (const station of plan.stations) {
        if (station.hotDesk) continue;
        labels[station.id] = project(labelAnchorFor(station));
      }

      const presentWorkers: string[] = [];
      for (const [id, state] of timeline.workers) {
        if (state.present.sampleAt(t)) presentWorkers.push(id);
      }

      setReadable({
        t,
        stationStatus,
        labels,
        presentWorkers,
        outbox: timeline.outboxCount.sampleAt(t) ?? 0,
      });
      onTimeRef.current?.(t, timeline.duration);
    },
    [timeline, plan.stations, project],
  );

  // --- camera ---------------------------------------------------------------
  /** Where the camera should settle. Derived from the host's selection rather than
   *  stored, so the two can never disagree about which desk is being looked at. */
  const focus = useMemo<World | null>(() => {
    if (selection?.kind !== 'station') return null;
    return plan.stations.find((s) => s.id === selection.id)?.seat ?? null;
  }, [selection, plan.stations]);
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
          ? new THREE.Vector3(focus.x, 0.6, focus.y)
          : current.centre.clone();
        const wantDistance = focus ? current.radius * 1.1 : current.radius * 2.15;

        if (!reducedMotion) cam.angle += deltaMs * 0.000018;
        cam.target.lerp(wantTarget, 0.06);
        cam.distance += (wantDistance - cam.distance) * 0.06;

        current.camera.position.set(
          cam.target.x + Math.cos(cam.angle) * cam.distance * 0.78,
          cam.distance * 0.62,
          cam.target.z + Math.sin(cam.angle) * cam.distance * 0.78,
        );
        current.camera.lookAt(cam.target);

        applyTime(clock.current.advance(deltaMs));
      },
      [applyTime, focus, reducedMotion],
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
      const hit = raycaster.intersectObjects(current.pickables, false)[0];
      if (!hit) {
        onSelectRef.current?.(null);
        return;
      }
      // Which desk owns the mesh that was hit.
      for (const [stationId, meshes] of current.liveMeshes) {
        if (!meshes.includes(hit.object as THREE.Mesh)) continue;
        onSelectRef.current?.({ kind: 'station', id: stationId });
        return;
      }
    },
    [],
  );

  const anyActive = Object.values(readable.stationStatus).some(Boolean);

  return (
    <div className="office-view office-stage" style={{ position: 'relative', width: '100%', height: '100%' }}>
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

      <div className="office-mode-stamp">{modeLabel}</div>

      {/* A canvas is opaque to a screen reader, so the parallel outline matters more
          here than it did in SVG, not less. */}
      <div className="office-outline">
        <h3>{plan.label}</h3>
        <p aria-live="polite">
          {anyActive ? 'Work is in progress.' : 'The office is idle.'} {readable.outbox} finished
          {readable.outbox === 1 ? ' item' : ' items'} in the outbox.
        </p>
        <ul>
          {plan.stations
            .filter((station) => !station.hotDesk)
            .map((station) => (
              <li key={station.id}>
                <strong>{station.role}</strong>: {readable.stationStatus[station.id] ?? 'Standing by'}
              </li>
            ))}
        </ul>
        <p>{readable.presentWorkers.length} on the floor.</p>
      </div>
    </div>
  );
}

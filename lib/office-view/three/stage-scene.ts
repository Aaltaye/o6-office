/**
 * office-view/three/stage-scene — building the office as actual geometry.
 *
 * This is the second renderer behind the same event contract, and it exists because the
 * architecture allowed it: `core/` is DOM-free and produces positions over time, so a
 * three.js stage consumes exactly what the SVG office consumes. Nothing about the
 * workflow, the bridge, or the honesty rules changes.
 *
 * Coordinate mapping, the one thing to get right up front. The floor plan thinks in
 * `x` east, `y` south, `z` up — the convention the isometric projection uses. three.js
 * uses `y` for up and `z` for depth, so every conversion goes through `toScene()`. Doing
 * it in one place is the difference between a coherent scene and an afternoon of
 * mysteriously mirrored furniture.
 *
 * Art direction: the *architecture* stays porcelain and calm; the *people* carry colour.
 * A room where everything is colourful has nowhere for the eye to land, and the whole
 * point is that you can see who is working. Violet still means, and only means, live.
 */

import * as THREE from 'three';

import type { FloorPlan, PropKind, World } from '../core/types.ts';
import { WORKER_RADIUS } from '../core/figure.ts';
import { palette, PROP_SHAPES, geometry } from '../art/theme.ts';
import {
  buildBooks,
  buildCooler,
  buildDeskKit,
  buildMeetingArea,
  buildPlant,
  buildRoomShell,
  buildRug,
  buildStickies,
  buildWallDisplay,
  planBox,
  room,
} from './room-kit.ts';

/** Floor-plan space to three.js space. `y` is up in three, `z` is up in the plan. */
export function toScene(at: World): THREE.Vector3 {
  return new THREE.Vector3(at.x, at.z ?? 0, at.y);
}

/** Materials are shared: one instance per look, reused across every mesh that wants it. */
export function createMaterials() {
  const surface = (color: string, roughness = 0.85) =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness: 0 });

  return {
    // The room shell supplies the floor now; this is only a fallback.
    floor: surface(room.floor, 0.9),
    // Room pads are barely-there mats on the wood, not slabs. Under a wood floor they
    // want to be quiet — the walls and the daylight do the work of defining space.
    room: surface('#D9C4A6', 0.95),
    // Desks are pale wood rather than porcelain. This is the single biggest step toward
    // the reference: a white desk on a wood floor reads as a laboratory, a wood desk
    // reads as somewhere people work.
    desk: surface(room.wood, 0.78),
    deskEdge: surface('#B08F67', 0.85),
    structure: surface('#DCD8CF', 0.9),
    // Props that want to read as equipment rather than furniture.
    dark: surface('#3E4450', 0.6),
    board: surface('#FDFDFB', 0.65),
    foliage: surface('#6F8B58', 0.9),
    // The only colour that means something. Emissive so a busy desk genuinely glows
    // rather than just being a different shade.
    live: new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.violet),
      emissive: new THREE.Color(palette.violet),
      emissiveIntensity: 0.35,
      roughness: 0.5,
    }),
    /*
     * A finished agent, still at the desk it used so its work can be reviewed.
     *
     * Deliberately the quietest thing on the floor: no identity colour, translucent, and
     * drawn without a shadow by setWorkerDormant. It has to be impossible to mistake for
     * somebody working, and it is nowhere near violet — violet means right now.
     */
    dormantWorker: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#A9AEB8'),
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0.42,
    }),
  };
}

export type Materials = ReturnType<typeof createMaterials>;

/**
 * Lighting.
 *
 * One key light casting soft shadows, plus enough fill that nothing goes muddy. Shadows
 * are what make a 3D office feel like a real place rather than flat shapes at angles, so
 * they are worth the cost — but a single soft key is plenty. Multiple shadow-casting
 * lights would double the cost for a picture nobody would read as better.
 */
export function addLighting(scene: THREE.Scene, plan: FloorPlan) {
  const centre = planCentre(plan);

  // Sky above, warm bounce off the wood below.
  scene.add(new THREE.HemisphereLight(0xf4f8ff, 0xc8a984, 1.0));

  // Daylight, coming through the window wall on the west so the shadows agree with the
  // architecture. A key light from nowhere is the fastest way to make a room feel fake.
  const bounds = planBox(plan);
  const key = new THREE.DirectionalLight(0xfff1dc, 2.9);
  key.position.set(bounds.minX - 6, 11, centre.z + 4);
  key.target.position.set(centre.x, 0, centre.z);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 60;
  // Fit the shadow frustum to the floor. Too wide and the shadows turn to mush.
  const extent = Math.max(plan.rooms.length * 2, 16);
  Object.assign(key.shadow.camera, {
    left: -extent,
    right: extent,
    top: extent,
    bottom: -extent,
  });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  // A cool bounce from the opposite side so shadowed faces keep their form.
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.6);
  fill.position.set(centre.x + 8, 9, centre.z + 10);
  scene.add(fill);
}

/** Middle of the floor, in scene space — used to aim lights and the camera. */
export function planCentre(plan: FloorPlan): THREE.Vector3 {
  const points = [
    ...plan.stations.map((s) => s.seat),
    ...plan.rooms.map((r) => r.origin),
    plan.inbox.at,
    plan.outbox.at,
  ];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return new THREE.Vector3(
    (Math.min(...xs) + Math.max(...xs)) / 2,
    0,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  );
}

/** Extent of the floor, so the camera can frame the whole plan whatever its shape. */
export function planRadius(plan: FloorPlan): number {
  const centre = planCentre(plan);
  const points = [...plan.stations.map((s) => s.seat), plan.inbox.at, plan.outbox.at];
  return Math.max(
    ...points.map((p) => Math.hypot(p.x - centre.x, p.y - centre.z)),
    8,
  );
}

/** A box with softened edges. Everything in this office is built from these. */
function roundedBox(w: number, h: number, d: number, radius = 0.04) {
  // three has no rounded-box primitive; a small bevel via a slightly inset second box is
  // more geometry than it is worth. A plain box with a soft material reads fine at this
  // scale, and keeps the vertex count low enough for a phone.
  void radius;
  return new THREE.BoxGeometry(w, h, d);
}

function mesh(
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.copy(position);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Which way is 'forward' for a worker at a desk, in scene space. */
export function facingVector(facing: string): { x: number; y: number } {
  if (facing === 'e') return { x: 1, y: 0 };
  if (facing === 'w') return { x: -1, y: 0 };
  if (facing === 'n') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

/**
 * Where a desk stands relative to the person using it.
 *
 * The plan's seat is where the worker is. The desk goes in front of them — obvious in
 * a real room, and easy to get wrong once you have been drawing top-down sprites where
 * the two could overlap harmlessly.
 */
export const DESK_OFFSET = 0.62;
export function deskCentre(seat: { x: number; y: number }, facing: string) {
  const dir = facingVector(facing);
  return { x: seat.x + dir.x * DESK_OFFSET, y: seat.y + dir.y * DESK_OFFSET };
}

/** Props that should read as equipment rather than furniture. */
const DARK_PROPS = new Set<PropKind>(['screen', 'rack']);

/**
 * Build everything that never moves: the ground, the room pads, the desks, the trays and
 * every department's furniture.
 *
 * Returns the group plus a lookup from station id to the meshes that should glow when
 * that desk is live, so the animation loop can light a department without searching the
 * scene graph every frame.
 */
export function buildStaticScene(plan: FloorPlan, materials: Materials) {
  const root = new THREE.Group();
  const liveMeshes = new Map<string, THREE.Mesh[]>();
  const stationAnchors = new Map<string, THREE.Vector3>();

  // The shell: wood floor, two walls, and a window wall the daylight comes through.
  // Only two walls, and only the ones furthest from the camera — a fully enclosed room
  // would be architecturally honest and completely unusable.
  const centre = planCentre(plan);
  const shell = buildRoomShell(plan);
  root.add(shell.group);
  const bounds = shell.bounds;

  for (const area of plan.rooms) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(area.size.w, 0.02, area.size.h), materials.room);
    pad.position.set(area.origin.x + area.size.w / 2, 0.012, area.origin.y + area.size.h / 2);
    pad.receiveShadow = true;
    pad.castShadow = false;
    root.add(pad);
  }

  for (const station of plan.stations) {
    const size = station.hotDesk ? geometry.hotDesk : geometry.desk;
    const desk = deskCentre(station.seat, station.facing);
    const glowing: THREE.Mesh[] = [];

    // The desk top, and a slimmer base under it so it does not read as a solid block.
    const top = mesh(
      roundedBox(size.w, 0.08, size.d),
      materials.desk,
      new THREE.Vector3(desk.x, size.h, desk.y),
    );
    root.add(top);
    glowing.push(top);

    const base = mesh(
      roundedBox(size.w * 0.82, size.h, size.d * 0.7),
      materials.deskEdge,
      new THREE.Vector3(desk.x, size.h / 2, desk.y),
    );
    root.add(base);

    if (!station.hotDesk) {
      // A monitor, a keyboard and a lamp. These three objects are what make a desk read
      // as a workstation rather than a table, and the reference leans on them heavily.
      root.add(buildDeskKit(desk, size.h, station.facing as 'e' | 'w' | 'n' | 's'));

      /*
       * One rug per DEPARTMENT, sized to its whole desk run — not one per desk.
       *
       * A rug is 2.6 across and neighbouring desks are 1.8 apart, so a rug each overlapped
       * its neighbours by 0.8 and the department read as a smear of red rather than as a
       * floor. The rug is drawn by the department's first desk and stretched to cover the
       * rest, which is also what a real office does: a pod of desks sits on one mat.
       */
      if (!station.satellite) {
        const xs = plan.stations.filter((s) => s.room === station.room).map((s) => s.seat.x);
        const spread = Math.max(...xs) - Math.min(...xs);
        const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
        // The rug sits under the desks the same way it always did — half the desk's own
        // offset in front of the seats — just centred on the whole run instead of one seat.
        const deskOffsetX = desk.x - station.seat.x;
        root.add(
          buildRug(
            { x: midX + deskOffsetX / 2, y: (station.seat.y + desk.y) / 2 },
            2.6 + spread,
            2.2,
          ),
        );
      }
    }

    for (const trayAt of [station.inTray, station.outTray].filter((p) => p !== undefined)) {
      root.add(
        mesh(
          roundedBox(0.38, 0.05, 0.3),
          materials.structure,
          new THREE.Vector3(trayAt.x, 0.03, trayAt.y),
        ),
      );
    }

    // Department furniture — the same data the SVG office draws, in three dimensions.
    for (const prop of station.props ?? []) {
      const shape = PROP_SHAPES[prop.kind];
      const at = { x: desk.x + prop.at.x, y: desk.y + prop.at.y };
      const material =
        prop.kind === 'plant'
          ? materials.foliage
          : prop.kind === 'board'
            ? materials.board
            : DARK_PROPS.has(prop.kind)
              ? materials.dark
              : materials.desk;

      if (prop.kind === 'plant') {
        root.add(buildPlant(at, 1.05));
      } else {
        root.add(
          mesh(
            roundedBox(shape.w, shape.h, shape.d),
            material,
            new THREE.Vector3(at.x, shape.h / 2, at.y),
          ),
        );
      }

      if (prop.kind === 'shelf') root.add(buildBooks(at, shape.w, shape.h));
      if (prop.kind === 'board') {
        root.add(buildStickies(at, shape.w, shape.h, station.facing === 'w' ? 'w' : 'e'));
      }
    }

    liveMeshes.set(station.id, glowing);
    stationAnchors.set(station.id, new THREE.Vector3(desk.x, size.h + 0.1, desk.y));
  }

  // Communal scenery. None of it carries data — it exists so the space reads as a
  // workplace rather than a diagram, which is the whole reason a non-technical viewer
  // understands what they are looking at.
  root.add(buildWallDisplay(bounds.minX + 0.2, centre.z - 2.2, 2.4));
  root.add(buildMeetingArea({ x: bounds.maxX - 2.2, y: bounds.maxY - 2.4 }));
  root.add(buildCooler({ x: bounds.minX + 1.1, y: bounds.minY + 1.0 }));
  root.add(buildPlant({ x: bounds.maxX - 1.4, y: bounds.minY + 1.3 }, 1.5));
  root.add(buildPlant({ x: bounds.minX + 1.3, y: bounds.maxY - 1.6 }, 1.3));

  // Inbox and outbox: where work enters and leaves the building.
  for (const endpoint of [plan.inbox, plan.outbox]) {
    root.add(
      mesh(
        roundedBox(0.6, 0.12, 0.5),
        materials.structure,
        new THREE.Vector3(endpoint.at.x, 0.06, endpoint.at.y),
      ),
    );
  }

  // The door, as a frame rather than a solid, so it reads as an opening.
  for (const door of plan.doors) {
    const frame = mesh(
      roundedBox(1.2, 1.9, 0.08),
      materials.structure,
      new THREE.Vector3(door.at.x, 0.95, door.at.y),
    );
    frame.material = materials.board;
    root.add(frame);
  }

  return { root, liveMeshes, stationAnchors };
}

/**
 * A person: a rounded body and a head, in one colour.
 *
 * The reference this is modelled on gives each figure a strong identity colour, and that
 * turns out to be functional as well as friendly — you can follow one worker across the
 * floor without reading a label. Faceless still: posture and motion carry the meaning,
 * and we have no data about expressions to be honest with.
 */
export function buildWorker(color: string): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.55,
    metalness: 0,
  });

  // Big head, small body. That proportion is what makes the reference's figures read as
  // characters rather than as pieces on a board, and it survives being small on screen.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.22, 6, 18), material);
  body.position.y = 0.36;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 22, 18), material);
  head.position.y = 0.92;
  head.castShadow = true;
  group.add(head);

  /*
   * Two small ears, straight from the reference silhouette — and the widest part of the
   * whole figure, which is why the offset is derived from WORKER_RADIUS rather than
   * written as a literal. The scheduler reserves WORKER_DIAMETER of floor for a person;
   * if the ears were free to drift past it, workers would overlap again and nothing would
   * notice. (0.40 - 0.10 = 0.30, exactly where they have always been.)
   */
  const earRadius = 0.1;
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(earRadius, 12, 10), material);
    ear.position.set(side * (WORKER_RADIUS - earRadius), 1.08, 0);
    ear.castShadow = true;
    group.add(ear);
  }

  // Stubby arms, so the silhouette reads as a person rather than a pill.
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.2, 4, 10), material);
    arm.position.set(side * 0.31, 0.42, 0);
    arm.rotation.z = side * 0.5;
    arm.castShadow = true;
    group.add(arm);
  }

  return group;
}

/**
 * Identity colours for the cast.
 *
 * Assigned deterministically from the worker id so a replay colours everyone exactly as
 * the live run did — the same rule that governs hot desks and lane assignment.
 */
export const WORKER_COLORS = [
  '#E0524A', // red
  '#3B7DD8', // blue
  '#3E9E5F', // green
  '#E8B33C', // amber
  '#8B5CD6', // purple
  '#E07A3F', // orange
  '#39A9A5', // teal
  '#D45D9C', // pink
];

export function colorForWorker(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return WORKER_COLORS[hash % WORKER_COLORS.length];
}

/** A folder in transit. Small, bright, and unmistakably the thing being carried. */
export function buildFolder(): THREE.Mesh {
  const folder = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.06, 0.26),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.violet),
      emissive: new THREE.Color(palette.violet),
      emissiveIntensity: 0.3,
      roughness: 0.5,
    }),
  );
  folder.castShadow = true;
  return folder;
}

/**
 * Rendered label sizes, measured in the browser rather than guessed.
 *
 * Two widths, because a label's width depends on what it says. An idle desk reads
 * "Standing by" and measures 80px; a live desk carries a producer's literal action and
 * runs to the 168px `max-width` cap. A single averaged constant under-separates exactly
 * when a label is live — which is when it matters most — so the collision test uses the
 * width of each of the two labels it is comparing.
 *
 * Labels are positioned with `translate(-50%, -100%)`: `left` is the horizontal centre
 * and `top` the base. Measured height is a uniform 41px; the rest is breathing room.
 */
export const LABEL_BOX = { idleW: 80, activeW: 168, h: 45 };

/**
 * The same at the compact scale a narrow stage uses.
 *
 * These MUST stay in step with `.office-view.is-narrow .office-label` in office-view.css,
 * or de-collision measures a box the browser is not drawing. A test asserts the widths
 * match the stylesheet, because two files having to agree is exactly the kind of thing
 * that rots silently.
 */
export const LABEL_BOX_COMPACT = { idleW: 66, activeW: 116, h: 38 };

/**
 * How far apart to step live labels that could not be placed properly.
 *
 * Smaller than a label, deliberately: when there are more live labels than the frame can
 * hold they must overlap, and the useful thing to preserve is each one's top edge — the
 * line carrying the role and the first words of its status.
 */
const CLAMP_STEP = 16;

/** How wide this particular label is: a live status is much longer than "Standing by". */
function labelWidth(box: { idleW: number; activeW: number }, active: boolean): number {
  return active ? box.activeW : box.idleW;
}

/**
 * Should a desk show its label, or collapse to a dot?
 *
 * Pure and exported so the honesty invariant below is assertable from a .mjs test, which
 * cannot import the .tsx renderer.
 *
 * The rule: a dot only ever replaces "Standing by" — a string the RENDERER writes for an
 * idle desk, never something a producer said. A desk with a literal status keeps its
 * label at every screen size, and so does the desk the viewer selected. So no
 * producer-authored text is collapsed, ever, and the dot still marks that the desk exists.
 */
export function labelModeFor(input: {
  isNarrow: boolean;
  status: string | null;
  isSelected: boolean;
}): 'label' | 'dot' {
  if (!input.isNarrow) return 'label';
  // A literal action is never hidden to save room.
  if (input.status) return 'label';
  // Neither is the one the viewer asked for.
  if (input.isSelected) return 'label';
  return 'dot';
}

export type PlacedLabel = {
  left: number;
  top: number;
  visible: boolean;
  /** Carrying a live status: placed first, and never moved or hidden. */
  active?: boolean;
  /** Could not be placed in frame, so the renderer should draw a dot instead. */
  collapsed?: boolean;
};

/**
 * Nudge overlapping desk labels apart vertically.
 *
 * Each label is projected from its own desk independently, so two desks that line up
 * along the camera's view direction produce labels stacked on top of each other and one
 * becomes unreadable. This is a screen-space legibility pass only: no desk moves, no
 * status text changes, and no event is reordered.
 *
 * Three rules, in priority order:
 *  1. Live labels are placed first, so an idle label can never displace one carrying a
 *     producer's literal action. Note what this does NOT claim: when two LIVE labels
 *     collide, one of them has to move — that is arithmetic, not a policy choice. What is
 *     guaranteed is the asymmetry, that "Standing by" always yields to real work.
 *  2. The lift is bounded by the frame. The overlay clips with `overflow: hidden`, so
 *     lifting a label past the top edge would hide it while still calling it visible —
 *     a label removed with nothing said, which is the one thing this pass must not do.
 *  3. When a label cannot fit: an idle one collapses to a dot (it was only going to say
 *     "Standing by"), and a live one is clamped to the edge and allowed to overlap. An
 *     ugly frame is honest; a silently clipped one is not.
 *
 * Deterministic: ordering is active-first, then bottom-most, then by id, so the sort is
 * total rather than dependent on object insertion order.
 */
export function deCollideLabels<T extends PlacedLabel>(
  labels: Record<string, T>,
  options: { box?: { idleW: number; activeW: number; h: number }; frameHeight?: number | null } = {},
): Record<string, T> {
  const box = options.box ?? LABEL_BOX;
  const frameHeight = options.frameHeight ?? null;
  const out: Record<string, T> = {};
  const placed: { left: number; top: number; active: boolean }[] = [];
  /** How many live labels have had to be clamped, so each lands a step lower. */
  let clampedLive = 0;

  const order = Object.entries(labels)
    .filter(([, point]) => point.visible)
    .sort((a, b) => {
      const byActive = Number(Boolean(b[1].active)) - Number(Boolean(a[1].active));
      if (byActive !== 0) return byActive;
      if (b[1].top !== a[1].top) return b[1].top - a[1].top;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  for (const [id, point] of order) {
    const active = Boolean(point.active);
    const width = labelWidth(box, active);
    let top = point.top;
    let fits = true;

    // Bounded: a label can only be lifted so many times before we stop, which keeps a
    // pathological plan from spinning here.
    for (let guard = 0; guard < 24; guard += 1) {
      const hit = placed.find(
        (other) =>
          Math.abs(other.left - point.left) < (width + labelWidth(box, other.active)) / 2 &&
          Math.abs(other.top - top) < box.h,
      );
      if (!hit) break;
      const lifted = hit.top - box.h;
      if (frameHeight !== null && lifted - box.h < 0) {
        fits = false;
        break;
      }
      top = lifted;
    }

    if (!fits) {
      if (active) {
        /*
         * A live label is never hidden, so it is brought back inside the frame. Two things
         * would both be wrong here: clamping every one to the same top edge lands several
         * on the SAME pixel, where they read as one label; and cascading by a full label
         * height runs them off the bottom, which the overflow:hidden overlay clips just as
         * silently. So they step down by a fraction of a label and stay inside the frame —
         * overlapping when there are genuinely too many, but each one visibly present and
         * each one's own top edge readable.
         */
        const lowest = frameHeight === null ? box.h : Math.max(box.h, frameHeight);
        top = box.h + clampedLive * CLAMP_STEP;
        if (top > lowest) top = lowest;
        clampedLive += 1;
      } else {
        out[id] = { ...point, collapsed: true };
        continue;
      }
    }

    placed.push({ left: point.left, top, active });
    out[id] = { ...point, top };
  }

  // Labels outside the frustum keep their position; they are not drawn either way.
  for (const [id, point] of Object.entries(labels)) if (!(id in out)) out[id] = point;
  return out;
}

/**
 * Switch a figure between working and finished.
 *
 * A finished agent stays at the desk it used so a viewer can still see what it did, and it
 * has to be impossible to mistake for one that is working. Three things carry that, in
 * descending order of how much they matter:
 *
 *  1. NO SHADOW. A contact shadow is the claim that something is standing there. Removing
 *     it is what turns a figure into a marker, and it is the single detail that keeps this
 *     from being the office asserting a presence that ended.
 *  2. No identity colour. The cast's colours belong to agents that are running; a record
 *     takes the same graphite the structure uses, so it reads as part of the furniture.
 *  3. Transparency, so a live agent walking past is never occluded by a finished one.
 *
 * Violet is not involved at any point. Violet means "right now", and this is the opposite.
 */
export function setWorkerDormant(
  figure: THREE.Group,
  materials: ReturnType<typeof createMaterials>,
  dormant: boolean,
): void {
  if (figure.userData.dormant === dormant) return;
  figure.userData.dormant = dormant;

  if (dormant) {
    // Keep the live material so the figure can be brought back exactly as it was — a
    // replay scrubbed backwards past the departure has to show a working agent again.
    figure.userData.liveMaterial ??= (figure.children[0] as THREE.Mesh).material;
  }
  const live = figure.userData.liveMaterial as THREE.Material | undefined;

  figure.traverse((part) => {
    if (!(part instanceof THREE.Mesh)) return;
    part.castShadow = !dormant;
    part.receiveShadow = !dormant;
    if (dormant) part.material = materials.dormantWorker;
    else if (live) part.material = live;
  });
}

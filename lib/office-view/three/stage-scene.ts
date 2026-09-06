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
import { palette, PROP_SHAPES, geometry } from '../art/theme.ts';

/** Floor-plan space to three.js space. `y` is up in three, `z` is up in the plan. */
export function toScene(at: World): THREE.Vector3 {
  return new THREE.Vector3(at.x, at.z ?? 0, at.y);
}

/** Materials are shared: one instance per look, reused across every mesh that wants it. */
export function createMaterials() {
  const surface = (color: string, roughness = 0.85) =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness: 0 });

  return {
    // A warm mid-grey ground, so porcelain furniture standing on it actually reads as
    // standing on something. Straight porcelain-on-porcelain looked like fog.
    floor: surface('#CFCEC7', 0.98),
    room: surface('#E4E3DC', 0.95),
    desk: surface('#FBFBF9', 0.75),
    deskEdge: surface(palette.titanium, 0.85),
    structure: surface('#A9AEB8', 0.9),
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

  scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c8c1, 1.15));

  const key = new THREE.DirectionalLight(0xfff4e4, 2.6);
  key.position.set(centre.x + 9, 16, centre.z - 7);
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
  const fill = new THREE.DirectionalLight(0xe8ecff, 0.55);
  fill.position.set(centre.x - 10, 7, centre.z + 9);
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

  // Ground: one large plane so the office sits on something, with the room pads as
  // slightly raised islands on top of it.
  const centre = planCentre(plan);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    materials.floor,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centre.x, -0.02, centre.z);
  ground.receiveShadow = true;
  root.add(ground);

  for (const room of plan.rooms) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(room.size.w, 0.04, room.size.h), materials.room);
    pad.position.set(room.origin.x + room.size.w / 2, 0, room.origin.y + room.size.h / 2);
    pad.receiveShadow = true;
    root.add(pad);
  }

  for (const station of plan.stations) {
    const size = station.hotDesk ? geometry.hotDesk : geometry.desk;
    const glowing: THREE.Mesh[] = [];

    // The desk top, and a slimmer base under it so it does not read as a solid block.
    const top = mesh(
      roundedBox(size.w, 0.08, size.d),
      materials.desk,
      new THREE.Vector3(station.seat.x, size.h, station.seat.y),
    );
    root.add(top);
    glowing.push(top);

    const base = mesh(
      roundedBox(size.w * 0.82, size.h, size.d * 0.7),
      materials.deskEdge,
      new THREE.Vector3(station.seat.x, size.h / 2, station.seat.y),
    );
    root.add(base);

    for (const trayAt of [station.inTray, station.outTray]) {
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
      const at = { x: station.seat.x + prop.at.x, y: station.seat.y + prop.at.y };
      const material =
        prop.kind === 'plant'
          ? materials.foliage
          : prop.kind === 'board'
            ? materials.board
            : DARK_PROPS.has(prop.kind)
              ? materials.dark
              : materials.desk;

      root.add(
        mesh(
          roundedBox(shape.w, shape.h, shape.d),
          material,
          new THREE.Vector3(at.x, shape.h / 2, at.y),
        ),
      );

      // A plant gets a canopy, so it does not read as another crate.
      if (prop.kind === 'plant') {
        root.add(
          mesh(
            new THREE.SphereGeometry(0.26, 16, 12),
            materials.foliage,
            new THREE.Vector3(at.x, shape.h + 0.14, at.y),
          ),
        );
      }
    }

    liveMeshes.set(station.id, glowing);
    stationAnchors.set(station.id, new THREE.Vector3(station.seat.x, size.h + 0.1, station.seat.y));
  }

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

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.3, 6, 16), material);
  body.position.y = 0.42;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 16), material);
  head.position.y = 0.92;
  head.castShadow = true;
  group.add(head);

  // Stubby arms, so the silhouette reads as a person rather than a pill.
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 8), material);
    arm.position.set(side * 0.29, 0.48, 0);
    arm.rotation.z = side * 0.35;
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

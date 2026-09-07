/**
 * office-view/three/room-kit — the things that make it a room rather than a platform.
 *
 * The difference between "some furniture on a grey plane" and "an office" is mostly
 * architecture and clutter: walls to sit inside, daylight coming from somewhere, a warm
 * floor, and the small objects people actually work with. None of it is load-bearing for
 * the data — every piece here is scenery — but scenery is the entire reason a
 * non-technical viewer looks at this and understands it as a workplace.
 *
 * Everything is built from primitives and shared materials. No asset pipeline, no GLTF
 * per department: adding a new kind of desk stays a few lines of code rather than a
 * modelling job, which is the property that keeps this maintainable.
 */

import * as THREE from 'three';

import type { FloorPlan, World } from '../core/types.ts';
import { WORKER_RADIUS } from '../core/figure.ts';

/** The warm, domestic palette the reference gets its friendliness from. */
export const room = {
  floor: '#C9A882', // light oak
  floorSeam: '#BC9A73',
  wall: '#EFEDE7',
  wallShade: '#E2DFD7',
  skirting: '#D8D4CA',
  window: '#DCEBF5',
  frame: '#F7F7F4',
  rug: '#B84A3C',
  rugTrim: '#9E3B2F',
  wood: '#C8A57C',
  screen: '#2B303A',
  screenGlow: '#8FB8D8',
  metal: '#A8ADB6',
  plantPot: '#C4703F',
  book: ['#C05A4A', '#D8A24A', '#4E7FB8', '#5E9E6B', '#8B6BB0', '#C97A9E'],
} as const;

export function material(color: string, roughness = 0.85, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness,
    metalness: 0,
    ...opts,
  });
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * The shell's materials, made once.
 *
 * The building is rebuilt when it grows, and the builder used to allocate seven fresh
 * MeshStandardMaterials every time while only geometry was disposed — so each growth leaked
 * seven materials and their GPU programs. They are identical every time, so they are shared:
 * the leak stops existing rather than being cleaned up after.
 */
let sharedShellMaterials: ReturnType<typeof makeShellMaterials> | null = null;

function makeShellMaterials() {
  return {
    floorMat: material(room.floor, 0.9),
    wallMat: material(room.wall, 0.95),
    shadeMat: material(room.wallShade, 0.95),
    skirtMat: material(room.skirting, 0.9),
    frameMat: material(room.frame, 0.8),
    seamMat: material(room.floorSeam, 0.92),
    glassMat: material(room.window, 0.25, {
      emissive: new THREE.Color(room.window),
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.85,
    }),
  };
}

function shellMaterials() {
  sharedShellMaterials ??= makeShellMaterials();
  return sharedShellMaterials;
}

/** The rectangle the building covers. */
export type ShellBox = { minX: number; maxX: number; minY: number; maxY: number };

/** Bounds of everything on the plan, so walls can be placed around it. */
export function planBox(plan: FloorPlan) {
  const points: World[] = [
    ...plan.stations.flatMap((s) => [s.seat, s.inTray, s.outTray].filter((p) => p !== undefined)),
    ...plan.rooms.flatMap((r) => [
      r.origin,
      { x: r.origin.x + r.size.w, y: r.origin.y + r.size.h },
    ]),
    ...plan.aisle.nodes.map((n) => n.at),
    plan.inbox.at,
    plan.outbox.at,
  ];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs) - 2.5,
    maxX: Math.max(...xs) + 2.5,
    minY: Math.min(...ys) - 2.5,
    maxY: Math.max(...ys) + 2.5,
  };
}

/**
 * The shell: a wood floor, two walls, and a window wall with daylight.
 *
 * Only two walls, and only the two furthest from the camera. A fully enclosed room would
 * be architecturally honest and completely unusable — you would be looking at the inside
 * of a box. This is the same trick a stage set uses.
 */
export function buildRoomShell(plan: FloorPlan, over?: ShellBox) {
  const group = new THREE.Group();
  /*
   * The box the building covers.
   *
   * Defaults to the plan's own extent, which is the ordinary office. It can be given a
   * larger one because a burst of concurrent agents stands beyond the desks — measured,
   * fifty agents into a single department reach 1.4 units past the floor and a hundred and
   * twenty reach 5.7 — and a room whose floor stops under their feet is a worse drawing
   * than a room that is bigger than it needs to be.
   */
  /*
   * `home` is the plan's own box and never changes; `bounds` is what the building covers
   * right now. Every piece of visible DETAIL is positioned from `home`, so growing the room
   * only ever adds more of it at the edges — nothing already on screen shifts. Positioning
   * detail from `bounds` instead slid every floorboard and re-flowed every window each time
   * the room changed size, which made a bigger office read as a different office.
   */
  const home = planBox(plan);
  const bounds = over ?? home;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minY + bounds.maxY) / 2;

  const { floorMat, wallMat, shadeMat, skirtMat, frameMat, glassMat, seamMat } = shellMaterials();

  const floor = box(width, 0.12, depth, floorMat, cx, -0.06, cz);
  floor.castShadow = false;
  group.add(floor);

  /*
   * Plank seams. Cheap, and the single strongest cue that the floor is wood rather than a
   * grey surface that happens to be brown.
   *
   * Indexed off `home` rather than walked from the current edge, so a given plank is always
   * in the same place. They span the full width, so widening the room moves none of them —
   * it only adds boards at the near and far ends, which is what a bigger floor looks like.
   */
  const SEAM_PITCH = 1.15;
  const seamOrigin = home.minY + 1;
  const firstSeam = Math.ceil((bounds.minY - seamOrigin) / SEAM_PITCH);
  const lastSeam = Math.floor((bounds.maxY - seamOrigin) / SEAM_PITCH);
  for (let k = firstSeam; k <= lastSeam; k += 1) {
    const z = seamOrigin + k * SEAM_PITCH;
    if (z <= bounds.minY || z >= bounds.maxY) continue;
    const seam = box(width, 0.01, 0.035, seamMat, cx, 0.005, z);
    seam.castShadow = false;
    group.add(seam);
  }

  const WALL_H = 4.2;

  // Back wall (north), behind everything.
  const back = box(width, WALL_H, 0.18, wallMat, cx, WALL_H / 2, bounds.minY);
  back.castShadow = false;
  group.add(back);
  group.add(box(width, 0.12, 0.24, skirtMat, cx, 0.06, bounds.minY));

  // Window wall (west), with daylight coming through it.
  const side = box(0.18, WALL_H, depth, shadeMat, bounds.minX, WALL_H / 2, cz);
  side.castShadow = false;
  group.add(side);
  group.add(box(0.24, 0.12, depth, skirtMat, bounds.minX, 0.06, cz));

  /*
   * Windows, at a pitch fixed by the plan and positions indexed off `home`.
   *
   * The old form divided the CURRENT depth into a whole number of windows, so every window
   * in the wall changed size and slid the moment the wall got longer. Now the pitch is a
   * constant of the building and growth simply reveals more windows, which is both what a
   * longer wall actually looks like and the only version where nothing already drawn moves.
   */
  const homeDepth = home.maxY - home.minY;
  const windowDepth = homeDepth / Math.max(2, Math.floor(homeDepth / 4.5));
  const firstWindow = Math.floor((bounds.minY - home.minY) / windowDepth) - 1;
  const lastWindow = Math.ceil((bounds.maxY - home.minY) / windowDepth) + 1;
  for (let i = firstWindow; i <= lastWindow; i++) {
    const z = home.minY + windowDepth * (i + 0.5);
    // Only whole windows, and only ones the wall actually reaches.
    if (z - windowDepth / 2 < bounds.minY || z + windowDepth / 2 > bounds.maxY) continue;
    const h = 2.5;
    const y = 1.9;
    const glass = box(0.06, h, windowDepth * 0.68, glassMat, bounds.minX + 0.08, y, z);
    glass.castShadow = false;
    group.add(glass);
    // Frame, so the window reads as a window rather than a glowing hole.
    for (const [fw, fh, fy, fz] of [
      [0.1, h + 0.16, y, z - (windowDepth * 0.68) / 2],
      [0.1, h + 0.16, y, z + (windowDepth * 0.68) / 2],
    ] as const) {
      group.add(box(fw, fh, 0.08, frameMat, bounds.minX + 0.1, fy, fz));
    }
    group.add(box(0.12, 0.09, windowDepth * 0.72, frameMat, bounds.minX + 0.1, y + h / 2, z));
    group.add(box(0.12, 0.09, windowDepth * 0.72, frameMat, bounds.minX + 0.1, y - h / 2, z));
  }

  /*
   * Things bolted to the architecture, built WITH it.
   *
   * They used to be added to the scene root from the shell's box at build time, so when the
   * west wall moved out the wall-mounted screen went on hanging in the air where the wall
   * had been, and the meeting corner sat stranded in the middle of the new floor. Anything
   * positioned from the walls has to be rebuilt with the walls.
   */
  group.add(buildWallDisplay(bounds.minX + 0.2, cz - 2.2, 2.4));
  group.add(buildMeetingArea({ x: bounds.maxX - 2.2, y: bounds.maxY - 2.4 }));

  return { group, bounds };
}

/** A rug. Anchors a desk to the floor and gives the eye somewhere warm to land. */
export function buildRug(at: World, w: number, d: number) {
  const group = new THREE.Group();
  const rug = box(w, 0.02, d, material(room.rug, 0.98), at.x, 0.008, at.y);
  rug.castShadow = false;
  group.add(rug);
  const trim = box(w * 0.9, 0.021, d * 0.86, material(room.rugTrim, 0.98), at.x, 0.012, at.y);
  trim.castShadow = false;
  group.add(trim);
  return group;
}

/**
 * A monitor, keyboard and desk lamp.
 *
 * The reference's desks are legible as *workstations* because of exactly these three
 * objects. Without them a desk is a table.
 */
export function buildDeskKit(at: World, deskHeight: number, facing: 'e' | 'w' | 'n' | 's') {
  const group = new THREE.Group();
  const dark = material(room.screen, 0.45);
  const glow = material(room.screenGlow, 0.3, {
    emissive: new THREE.Color(room.screenGlow),
    emissiveIntensity: 0.5,
  });
  const metal = material(room.metal, 0.55);

  // Which way the worker faces decides which side the monitor sits on.
  const dir = facing === 'e' ? 1 : facing === 'w' ? -1 : 0;
  const dirZ = facing === 's' ? 1 : facing === 'n' ? -1 : 0;
  const back = { x: at.x - dir * 0.42, y: at.y - dirZ * 0.42 };

  group.add(box(0.1, 0.16, 0.1, metal, back.x, deskHeight + 0.12, back.y));
  group.add(box(0.26, 0.03, 0.16, metal, back.x, deskHeight + 0.04, back.y));

  const screenW = Math.abs(dir) > 0 ? 0.06 : 0.62;
  const screenD = Math.abs(dir) > 0 ? 0.62 : 0.06;
  group.add(box(screenW, 0.38, screenD, dark, back.x, deskHeight + 0.4, back.y));
  group.add(
    box(
      screenW * 0.7 + 0.01,
      0.3,
      screenD * 0.7 + 0.01,
      glow,
      back.x + dir * 0.025,
      deskHeight + 0.4,
      back.y + dirZ * 0.025,
    ),
  );

  // Keyboard, in front of the monitor.
  const front = { x: at.x + dir * 0.12, y: at.y + dirZ * 0.12 };
  group.add(
    box(
      Math.abs(dir) > 0 ? 0.16 : 0.42,
      0.025,
      Math.abs(dir) > 0 ? 0.42 : 0.16,
      material('#E6E6EA', 0.7),
      front.x,
      deskHeight + 0.05,
      front.y,
    ),
  );

  // Lamp: a post, an arm, and a shade.
  const lamp = { x: at.x - dir * 0.5 + (dir === 0 ? 0.5 : 0), y: at.y - dirZ * 0.5 + (dirZ === 0 ? 0.45 : 0) };
  group.add(box(0.09, 0.03, 0.09, metal, lamp.x, deskHeight + 0.05, lamp.y));
  const post = box(0.035, 0.34, 0.035, metal, lamp.x, deskHeight + 0.22, lamp.y);
  group.add(post);
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.14, 14, 1, true),
    material('#F2F2EE', 0.7, { side: THREE.DoubleSide }),
  );
  shade.position.set(lamp.x, deskHeight + 0.42, lamp.y);
  shade.rotation.z = 0.35;
  shade.castShadow = true;
  group.add(shade);

  return group;
}

/** Coloured spines, so a shelf reads as books rather than as a slab. */
export function buildBooks(at: World, shelfW: number, shelfH: number) {
  const group = new THREE.Group();
  const rows = 2;
  for (let row = 0; row < rows; row++) {
    const y = shelfH * (row === 0 ? 0.32 : 0.72);
    let x = at.x - shelfW / 2 + 0.08;
    let i = row * 3;
    while (x < at.x + shelfW / 2 - 0.08) {
      const w = 0.05 + ((i * 7) % 4) * 0.012;
      const h = 0.2 + ((i * 5) % 3) * 0.045;
      group.add(
        box(w, h, 0.2, material(room.book[i % room.book.length], 0.85), x, y + h / 2, at.y),
      );
      x += w + 0.012;
      i++;
    }
  }
  return group;
}

/** Sticky notes on a board. The reference's whiteboard is what makes it feel like work. */
export function buildStickies(at: World, boardW: number, boardH: number, facing: 'e' | 'w') {
  const group = new THREE.Group();
  const dir = facing === 'e' ? 1 : -1;
  const colors = ['#F2D45C', '#F2D45C', '#F5B85C', '#EFE07A'];
  let n = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      // A couple of gaps, so it looks used rather than printed.
      if ((row * 3 + col) % 5 === 4) continue;
      const note = box(
        0.02,
        0.13,
        0.13,
        material(colors[n % colors.length], 0.9),
        at.x + dir * 0.06,
        boardH * 0.32 + row * 0.17,
        at.y - 0.3 + col * 0.3,
      );
      note.castShadow = false;
      group.add(note);
      n++;
    }
  }
  return group;
}

/**
 * A wall-mounted status display.
 *
 * Deliberately abstract: bars and a line, no numbers. A dashboard with invented figures
 * on it would be the office asserting data it does not have, which is the one thing this
 * product must never do — even in the scenery.
 */
export function buildWallDisplay(x: number, z: number, wallY: number) {
  const group = new THREE.Group();
  group.add(box(0.12, 1.5, 2.6, material('#1F2228', 0.5), x, wallY, z));
  group.add(
    box(0.04, 1.34, 2.44, material('#EDF2F7', 0.35, {
      emissive: new THREE.Color('#DCE8F2'),
      emissiveIntensity: 0.35,
    }), x + 0.07, wallY, z),
  );

  // Abstract chart furniture only.
  const ink = material('#7E93AC', 0.6);
  const accent = material('#7446FF', 0.5, {
    emissive: new THREE.Color('#7446FF'),
    emissiveIntensity: 0.25,
  });
  for (let i = 0; i < 6; i++) {
    const h = 0.16 + ((i * 13) % 5) * 0.09;
    group.add(box(0.02, h, 0.14, i === 4 ? accent : ink, x + 0.1, wallY - 0.42 + h / 2, z - 0.85 + i * 0.3));
  }
  for (let i = 0; i < 4; i++) {
    group.add(box(0.02, 0.05, 0.5 - i * 0.08, ink, x + 0.1, wallY + 0.42 - i * 0.15, z - 0.6));
  }
  return group;
}

/** A round meeting table with stools. Every office has one and nobody is ever at it. */
export function buildMeetingArea(at: World) {
  const group = new THREE.Group();
  const woodMat = material(room.wood, 0.8);
  const metal = material(room.metal, 0.6);

  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.07, 28), woodMat);
  top.position.set(at.x, 0.74, at.y);
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 0.72, 14), metal);
  post.position.set(at.x, 0.36, at.y);
  post.castShadow = true;
  group.add(post);

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + 0.4;
    const sx = at.x + Math.cos(angle) * 1.15;
    const sz = at.y + Math.sin(angle) * 1.15;
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 18), material('#E3E1DA', 0.85));
    seat.position.set(sx, 0.46, sz);
    seat.castShadow = true;
    group.add(seat);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.44, 10), metal);
    leg.position.set(sx, 0.22, sz);
    leg.castShadow = true;
    group.add(leg);
  }

  return group;
}

/** A potted plant with a terracotta pot — warmer than the abstract green block. */
export function buildPlant(at: World, scale = 1) {
  const group = new THREE.Group();
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19 * scale, 0.14 * scale, 0.28 * scale, 16),
    material(room.plantPot, 0.9),
  );
  pot.position.set(at.x, 0.14 * scale, at.y);
  pot.castShadow = true;
  group.add(pot);

  const foliage = material('#5F8A55', 0.9);
  for (const [dx, dy, dz, r] of [
    [0, 0.46, 0, 0.26],
    [0.14, 0.36, 0.08, 0.18],
    [-0.12, 0.4, -0.09, 0.16],
  ] as const) {
    const blob = new THREE.Mesh(new THREE.SphereGeometry(r * scale, 14, 10), foliage);
    blob.position.set(at.x + dx * scale, dy * scale, at.y + dz * scale);
    blob.castShadow = true;
    group.add(blob);
  }
  return group;
}

/** A water cooler, straight from the reference. Pure scenery, and the room needs it. */
export function buildCooler(at: World) {
  const group = new THREE.Group();
  group.add(box(0.42, 0.9, 0.42, material('#E8E8EC', 0.8), at.x, 0.45, at.y));
  const bottle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.2, 0.44, 16),
    material('#BEE0F0', 0.25, { transparent: true, opacity: 0.85 }),
  );
  bottle.position.set(at.x, 1.14, at.y);
  bottle.castShadow = true;
  group.add(bottle);
  return group;
}

/**
 * How much the building grows at a time.
 *
 * Coarse on purpose. The office is redrawn when this changes, so a fine step would mean
 * rebuilding the shell constantly as a crowd shifts by centimetres; a coarse one means it
 * happens a few times in the worst session anybody will run. Measured: a hundred and twenty
 * agents in one department reach 5.7 units past the floor, so two steps covers the extreme.
 */
const GROWTH_STEP = 4;

/**
 * The box the building has to cover: its own furniture, plus anyone standing outside it.
 *
 * Rounded outward to whole steps, which is what stops it flickering between two sizes when
 * somebody hovers on a boundary.
 */
export function neededShell(
  plan: FloorPlan,
  crowd: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
): ShellBox {
  const base = planBox(plan);
  if (!crowd) return base;
  /*
   * The crowd box holds worker CENTRES, so the margin only has to cover a person's own
   * half-width plus a little floor to stand on — not a room-sized 2.5.
   *
   * Measured with 2.5: the lead office grew with three concurrent agents, while the crowd
   * was still 1.98 units INSIDE the drawn floor and 1.58 clear of any silhouette. Rebuilding
   * the building because somebody stood near the middle of it is not "growing to match".
   */
  const air = WORKER_RADIUS + 0.5;
  const out = (over: number) => Math.ceil(Math.max(0, over) / GROWTH_STEP) * GROWTH_STEP;
  return {
    minX: base.minX - out(base.minX - (crowd.minX - air)),
    maxX: base.maxX + out(crowd.maxX + air - base.maxX),
    minY: base.minY - out(base.minY - (crowd.minZ - air)),
    maxY: base.maxY + out(crowd.maxZ + air - base.maxY),
  };
}

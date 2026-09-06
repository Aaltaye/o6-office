/**
 * office-view/art/sprites — the objects in the model.
 *
 * Every sprite is a pure function of world position and a few flags. None of them hold
 * state, none of them read the clock, and none of them animate themselves: the animation
 * loop writes transforms onto their group elements from outside. That separation is what
 * keeps 60fps motion out of React's render path.
 *
 * Hard rules, all of them load-bearing:
 *  - No SVG filters. Depth is flat tonal steps and alpha, never `feDropShadow` or
 *    `feGaussianBlur` — filters are the real SVG performance cliff on mobile.
 *  - Violet only ever means "happening right now".
 *  - Faceless figures. Posture and motion carry the meaning; a face would drag the model
 *    towards the uncanny valley and away from "architectural model with life inside it".
 *
 * Boundary rule: imports core types and the theme. Never app code, never the lead engine.
 */

import type { PropKind, World } from '../core/types.ts';
import { worldToScreen, type Tile } from '../core/projection.ts';
import { faces, geometry, live, palette, PROP_SHAPES, strokes } from './theme.ts';

/** Turn world points into an SVG polygon `points` string. */
function polygon(points: World[], tile: Tile): string {
  return points
    .map((point) => {
      const { sx, sy } = worldToScreen(point, tile);
      return `${sx.toFixed(2)},${sy.toFixed(2)}`;
    })
    .join(' ');
}

/**
 * The three visible faces of an axis-aligned box.
 *
 * With `x` east and `y` south, screen-y increases with both, so the camera sees the box's
 * east and south faces plus its top. Drawing exactly those three — no more — is what
 * makes a handful of polygons read as a solid object.
 */
export function isoBox(at: World, size: { w: number; d: number; h: number }, tile: Tile) {
  const { x, y } = at;
  const { w, d, h } = size;
  return {
    top: polygon(
      [
        { x, y, z: h },
        { x: x + w, y, z: h },
        { x: x + w, y: y + d, z: h },
        { x, y: y + d, z: h },
      ],
      tile,
    ),
    east: polygon(
      [
        { x: x + w, y, z: 0 },
        { x: x + w, y: y + d, z: 0 },
        { x: x + w, y: y + d, z: h },
        { x: x + w, y, z: h },
      ],
      tile,
    ),
    south: polygon(
      [
        { x, y: y + d, z: 0 },
        { x: x + w, y: y + d, z: 0 },
        { x: x + w, y: y + d, z: h },
        { x, y: y + d, z: h },
      ],
      tile,
    ),
    /** Flat contact shadow on the ground — a polygon, never a blur. */
    contact: polygon(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + d },
        { x, y: y + d },
      ],
      tile,
    ),
  };
}

type BoxProps = {
  at: World;
  size: { w: number; d: number; h: number };
  tile: Tile;
  /** Live activity tint. The only thing that may introduce violet. */
  active?: boolean;
  opacity?: number;
};

/** A generic solid. Desks, trays and folders are all this with different dimensions. */
export function IsoBox({ at, size, tile, active = false, opacity = 1 }: BoxProps) {
  const box = isoBox(at, size, tile);
  return (
    <g opacity={opacity}>
      <polygon points={box.contact} fill={faces.contact} />
      <polygon points={box.south} fill={active ? live.returning : faces.south} />
      <polygon points={box.east} fill={active ? live.solid : faces.east} />
      <polygon
        points={box.top}
        fill={active ? live.solid : faces.top}
        stroke={palette.titanium}
        strokeWidth={strokes.hairline}
        strokeLinejoin="round"
      />
    </g>
  );
}

/** A room's floor pad — the faintest possible step up from the ground plane. */
export function RoomPad({
  origin,
  size,
  tile,
  active = false,
}: {
  origin: World;
  size: { w: number; h: number };
  tile: Tile;
  active?: boolean;
}) {
  const points = polygon(
    [
      origin,
      { x: origin.x + size.w, y: origin.y },
      { x: origin.x + size.w, y: origin.y + size.h },
      { x: origin.x, y: origin.y + size.h },
    ],
    tile,
  );
  return (
    <>
      <polygon points={points} fill={faces.room} stroke={palette.titanium} strokeWidth={strokes.hairline} strokeOpacity={0.5} />
      {/* The light pool marking a busy room. Soft violet, and the only reason a room
          ever changes colour — attention is signalled here rather than by moving the
          camera, which would read as a game. */}
      {active ? <polygon points={points} fill={live.pool} /> : null}
    </>
  );
}

/** A desk. `hot` desks are visibly slighter, because a visitor's desk is temporary. */
export function Desk({
  at,
  tile,
  hot = false,
  active = false,
}: {
  at: World;
  tile: Tile;
  hot?: boolean;
  active?: boolean;
}) {
  const size = hot ? geometry.hotDesk : geometry.desk;
  // Centre the desk on its seat position so the plan can think in terms of "where the
  // person is" rather than "where the furniture's corner is".
  const origin = { x: at.x - size.w / 2, y: at.y - size.d / 2 };
  return <IsoBox at={origin} size={size} tile={tile} active={active} opacity={hot ? 0.9 : 1} />;
}

/**
 * A person. Faceless by design: a capsule and a head, no features.
 *
 * `moving` leans the figure very slightly, which is enough to read as walking without
 * animating limbs — and limbs would be a lie anyway, since we have no gait data.
 */
export function Worker({
  at,
  tile,
  active = false,
  specialist = false,
  moving = false,
}: {
  at: World;
  tile: Tile;
  active?: boolean;
  specialist?: boolean;
  moving?: boolean;
}) {
  const { bodyW, bodyH, headR, lift } = geometry.worker;
  const base = worldToScreen({ ...at, z: lift }, tile);
  const bodyWidthPx = bodyW * tile.w * 0.5;
  const bodyHeightPx = bodyH * tile.z;
  const headRadiusPx = headR * tile.z;

  const fill = active ? live.solid : specialist ? palette.titanium : '#9DA3B0';

  return (
    <g transform={`translate(${base.sx.toFixed(2)} ${base.sy.toFixed(2)})${moving ? ' rotate(-2)' : ''}`}>
      {/* Contact ellipse. A flat shape at low alpha, not a blurred shadow. */}
      <ellipse cx={0} cy={0} rx={bodyWidthPx * 0.62} ry={bodyWidthPx * 0.3} fill={faces.contact} />
      <rect
        x={-bodyWidthPx / 2}
        y={-bodyHeightPx}
        width={bodyWidthPx}
        height={bodyHeightPx}
        rx={bodyWidthPx / 2}
        fill={fill}
      />
      <circle cx={0} cy={-bodyHeightPx - headRadiusPx * 0.75} r={headRadiusPx} fill={fill} />
      {/* A visiting specialist reads as lighter and outlined — present, but not permanent. */}
      {specialist ? (
        <circle
          cx={0}
          cy={-bodyHeightPx - headRadiusPx * 0.75}
          r={headRadiusPx + 1.5}
          fill="none"
          stroke={active ? live.solid : palette.titanium}
          strokeWidth={strokes.hairline}
          strokeDasharray="2 2"
        />
      ) : null}
    </g>
  );
}

/**
 * A unit of work. Violet while in transit — it is the thing currently happening.
 *
 * `batched` marks a folder as part of a group moving together, drawn as a stack rather
 * than a number. An earlier version printed the group size on every folder, which read
 * as "six items each" instead of "six items between them" — the batch size is stated
 * once, in the compression pill, where it cannot be misread.
 */
export function Folder({
  at,
  tile,
  moving = false,
  batched = false,
}: {
  at: World;
  tile: Tile;
  moving?: boolean;
  batched?: boolean;
}) {
  const size = geometry.folder;
  const origin = { x: at.x - size.w / 2, y: at.y - size.d / 2 };

  return (
    <g>
      {/* A second sheet, slightly offset, so a grouped folder reads as a small stack. */}
      {batched ? (
        <IsoBox
          at={{ x: origin.x - 0.05, y: origin.y - 0.05 }}
          size={size}
          tile={tile}
          active={moving}
          opacity={0.55}
        />
      ) : null}
      <IsoBox at={origin} size={size} tile={tile} active={moving} />
    </g>
  );
}

/**
 * Department furniture.
 *
 * Six identical desks with six different captions is a diagram you have to read. Giving
 * each department its own silhouette means you can tell the workshop from the reading
 * room across the floor before any label loads — which is the point of showing work as a
 * place rather than a list.
 *
 * Every prop is built from the same three-face box, so they share one visual language and
 * cost nothing extra to draw. What distinguishes them is proportion: tall and narrow reads
 * as storage, wide and low reads as a surface, thin and upright reads as a screen.
 */

/** A few props read better in a lighter or darker tone than the standard furniture. */
const PROP_TONE: Partial<Record<PropKind, string>> = {
  screen: '#3E4450',
  rack: '#4A505C',
  board: '#FFFFFF',
  plant: '#8FA37E',
};

export function Prop({ kind, at, tile }: { kind: PropKind; at: World; tile: Tile }) {
  const size = PROP_SHAPES[kind];
  const origin = { x: at.x - size.w / 2, y: at.y - size.d / 2 };
  const box = isoBox(origin, size, tile);
  const tone = PROP_TONE[kind];

  return (
    <g>
      <polygon points={box.contact} fill={faces.contact} />
      <polygon points={box.south} fill={tone ?? faces.south} opacity={tone ? 0.82 : 1} />
      <polygon points={box.east} fill={tone ?? faces.east} opacity={tone ? 0.92 : 1} />
      <polygon
        points={box.top}
        fill={tone ?? faces.top}
        stroke={palette.titanium}
        strokeWidth={strokes.hairline}
        strokeLinejoin="round"
      />
      {/* A shelf gets one dividing line, a cabinet two — just enough to read as drawers
          or shelves rather than as a blank slab. */}
      {kind === 'shelf' || kind === 'cabinet' ? (
        <polygon
          points={isoBox(origin, { ...size, h: size.h * (kind === 'shelf' ? 0.62 : 0.5) }, tile).top}
          fill="none"
          stroke={palette.titanium}
          strokeWidth={strokes.hairline}
          strokeOpacity={0.75}
        />
      ) : null}
      {/* Foliage: one soft blob so a plant does not read as another crate. */}
      {kind === 'plant' ? (
        <ellipse
          cx={worldToScreen({ ...at, z: size.h }, tile).sx}
          cy={worldToScreen({ ...at, z: size.h }, tile).sy - tile.z * 0.12}
          rx={tile.w * 0.11}
          ry={tile.h * 0.16}
          fill="#8FA37E"
        />
      ) : null}
    </g>
  );
}

/** An in/out tray. Work physically sits in one of these between journeys. */
export function Tray({ at, tile, count = 0 }: { at: World; tile: Tile; count?: number }) {
  const size = geometry.tray;
  const origin = { x: at.x - size.w / 2, y: at.y - size.d / 2 };
  return (
    <g>
      <IsoBox at={origin} size={size} tile={tile} />
      {/* Paper stacks up as work accumulates — the outbox filling is the run's progress
          bar, expressed as an object rather than a widget. */}
      {Array.from({ length: Math.min(count, 6) }, (_, i) => (
        <IsoBox
          key={i}
          at={{ x: origin.x + 0.02, y: origin.y + 0.02 }}
          size={{ w: size.w - 0.04, d: size.d - 0.04, h: size.h + 0.03 * (i + 1) }}
          tile={tile}
        />
      ))}
    </g>
  );
}

/** The entrance. Specialists walk in and out through it, and so does the work. */
export function Door({ at, tile }: { at: World; tile: Tile }) {
  const { w, h } = geometry.door;
  const left = worldToScreen({ x: at.x - w / 2, y: at.y }, tile);
  const right = worldToScreen({ x: at.x + w / 2, y: at.y }, tile);
  return (
    <g>
      <line
        x1={left.sx}
        y1={left.sy}
        x2={right.sx}
        y2={right.sy}
        stroke={palette.titanium}
        strokeWidth={strokes.edge}
      />
      <polygon
        points={[
          `${left.sx.toFixed(2)},${left.sy.toFixed(2)}`,
          `${right.sx.toFixed(2)},${right.sy.toFixed(2)}`,
          `${right.sx.toFixed(2)},${(right.sy - h * tile.z).toFixed(2)}`,
          `${left.sx.toFixed(2)},${(left.sy - h * tile.z).toFixed(2)}`,
        ].join(' ')}
        fill={palette.porcelain}
        fillOpacity={0.55}
        stroke={palette.titanium}
        strokeWidth={strokes.hairline}
      />
    </g>
  );
}

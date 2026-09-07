/**
 * office-view/core/types — the contract.
 *
 * This file is the seam the whole product hangs on. Two very different producers
 * (the built-in lead-reactivation workflow, and a live Claude Code session arriving
 * over SSE from the local bridge) emit *only* these events, and the renderer consumes
 * *only* these events. Neither side knows about the other.
 *
 * Boundary rule (enforced by lint, see PLAN.md A7): `core/` imports nothing. Not React,
 * not the lead engine, not app code. If you find yourself wanting to import a domain
 * type here, the contract is wrong — generalise the event instead.
 *
 * Design notes worth knowing before you edit:
 *
 * - Events are a discriminated union on `type`, not a loose envelope with optional
 *   fields. The renderer switches on `type` and gets exhaustiveness checking for free,
 *   and the validator can be genuinely strict about what each variant requires.
 *
 * - `occurredAt` and `receivedAt` are deliberately separate. Scheduling orders by
 *   `occurredAt`. This is invariant I5 (PLAN.md A3): five parallel tool calls landing
 *   in the same millisecond are *genuinely simultaneous*, and a naive queue would
 *   serialise them into an ordering that never happened. That would be a lie told by
 *   the visualisation, which is the one thing this product cannot afford.
 *
 * - `direction` on a handoff is explicit, never inferred from "the destination happens
 *   to be upstream". The carried-backward moment (a reviewer walking work back to the
 *   desk that produced it) is a designed beat with its own path, pacing and label, so
 *   the producer has to actually state it.
 */

/** Contract version. Bump only for a breaking change; consumers reject other values. */
export const OFFICE_EVENT_VERSION = 1;

/** Stable identifiers. Strings rather than branded types — producers include a bridge
 *  written in plain JS, and a brand it cannot construct would be friction for no gain. */
export type StationId = string;
export type WorkerId = string;
export type WorkId = string;
export type RoomId = string;
export type AisleNodeId = string;

/** Which producer emitted this event. Used for labelling on screen, never for logic
 *  that changes how the office behaves — the whole point is that both render the same. */
/**
 * Who produced an event.
 *
 * 'external' covers every runtime that is not Claude Code — Codex, Replit, a loop
 * somebody wrote — reporting through the bridge's /event endpoint. It exists so the
 * office never has to guess, and never claims work was Claude Code's when it was not.
 */
export type EventSource = 'lead-workflow' | 'claude-code' | 'fixture' | 'external';

/** The two fixed endpoints every floor has, in addition to its stations. */
export type Endpoint = 'inbox' | 'outbox';

/** A reference to one unit of work — a lead, a file, a prompt. `label` is what the
 *  visitor reads on the folder, so it should be a human name, not an id. */
export type WorkRef = {
  id: WorkId;
  label: string;
};

/**
 * Token/cost reporting, which must always state where the number came from.
 *
 * `source: 'unavailable'` is a first-class case, not an absence. Claude Code hooks do
 * not carry usage at all (verified 2026-09-06), so when we cannot read the transcript
 * the office must render "unavailable" rather than a confident zero. A zero would read
 * as "this was free", which is false.
 */
export type UsageReport = {
  source: 'transcript' | 'provider-response' | 'unavailable';
  /** Attribution to a specific worker when known — e.g. a subagent's own token burn. */
  worker?: WorkerId;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Only ever an estimate, and only when we know the model's price. */
  estimatedCostUsd?: number;
};

/** Fields shared by every event variant. */
type BaseEvent = {
  v: typeof OFFICE_EVENT_VERSION;
  /** Unique within a run. Also seeds deterministic animation jitter, so it must be
   *  stable across a live run and its later replay — do not derive it from a counter
   *  that depends on arrival order. */
  id: string;
  /** Monotonic within a run. Ties in `occurredAt` are broken by this, and hot-desk and
   *  lane assignment are keyed by it, so replay matches live exactly. */
  seq: number;
  runId: string;
  source: EventSource;
  /** When it actually happened (epoch ms). Scheduling orders by this. */
  occurredAt: number;
  /** When we learned about it (epoch ms). Differs from `occurredAt` for buffered or
   *  reconnected streams; used to detect late arrivals, never to order them. */
  receivedAt?: number;
  /** The literal action, in plain language: "Reviewing draft against source notes".
   *  Never an invented inner monologue — we render what happened, not what an agent
   *  might have been "thinking". */
  label: string;
  detail?: string;
  /** Opaque producer payload, surfaced in the inspection panel. The renderer never
   *  interprets this. */
  payload?: unknown;
};

export type RunStarted = BaseEvent & {
  type: 'run.started';
  /** Which floor plan this run should be rendered on. */
  plan: string;
};

export type RunFinished = BaseEvent & {
  type: 'run.finished';
  outcome: 'completed' | 'stopped' | 'failed';
};

/** Work arrives — a lead lands in the inbox, a prompt is submitted. */
export type WorkReceived = BaseEvent & {
  type: 'work.received';
  work: WorkRef;
};

export type AssignmentStarted = BaseEvent & {
  type: 'assignment.started';
  station: StationId;
  worker?: WorkerId;
  work?: WorkRef;
};

export type AssignmentFinished = BaseEvent & {
  type: 'assignment.finished';
  station: StationId;
  worker?: WorkerId;
  work?: WorkRef;
};

/** A tool call failed, a check did not pass. Usually followed by a backward handoff. */
export type AssignmentFailed = BaseEvent & {
  type: 'assignment.failed';
  station: StationId;
  worker?: WorkerId;
  work?: WorkRef;
  reason: string;
};

/**
 * Work physically moves between desks. `direction: 'backward'` is the flagship beat:
 * a reviewer carrying work back to the desk that produced it, with the reason attached.
 */
export type Handoff = BaseEvent & {
  type: 'handoff';
  work: WorkRef;
  from: StationId | Endpoint;
  to: StationId | Endpoint;
  direction: 'forward' | 'backward';
  reason?: string;
};

/**
 * A bounded specialist joins — a subagent spawning, or a scoped model assignment.
 * Rendered as someone walking in through the door and taking a free hot desk.
 *
 * Honesty rule: only emit this when a genuinely separate unit of work started. The
 * local-rules path of the lead workflow must NOT emit it, because no specialist exists.
 */
export type SpecialistJoined = BaseEvent & {
  type: 'specialist.joined';
  worker: WorkerId;
  /** Display role, e.g. a subagent's `agent_type`. May be unknown to the floor plan,
   *  in which case the renderer assigns the lowest free hot desk by `seq`. */
  role: string;
  station?: StationId;
};

export type SpecialistLeft = BaseEvent & {
  type: 'specialist.left';
  worker: WorkerId;
};

/** Something was produced and can be opened — a draft, an edited file, a report. */
export type ArtifactCreated = BaseEvent & {
  type: 'artifact.created';
  artifact: { id: string; name: string; kind: string };
  station: StationId;
  work?: WorkRef;
};

/** A decision is waiting on a human — a permission prompt, an approval tray. */
export type ReviewRequested = BaseEvent & {
  type: 'review.requested';
  station: StationId;
  work?: WorkRef;
  question: string;
};

export type ReviewResolved = BaseEvent & {
  type: 'review.resolved';
  station: StationId;
  work?: WorkRef;
  decision: 'approved' | 'denied';
};

/** A desk is waiting on something else. Rendered as a "Waiting for …" sign. */
export type Blocked = BaseEvent & {
  type: 'blocked';
  station: StationId;
  work?: WorkRef;
  waitingOn: string;
};

export type UsageReported = BaseEvent & {
  type: 'usage.reported';
  usage: UsageReport;
};

/** Free-text run annotation with no floor consequence. Shows in the activity trail. */
export type Note = BaseEvent & {
  type: 'note';
};

export type OfficeEvent =
  | RunStarted
  | RunFinished
  | WorkReceived
  | AssignmentStarted
  | AssignmentFinished
  | AssignmentFailed
  | Handoff
  | SpecialistJoined
  | SpecialistLeft
  | ArtifactCreated
  | ReviewRequested
  | ReviewResolved
  | Blocked
  | UsageReported
  | Note;

export type OfficeEventType = OfficeEvent['type'];

/** Every valid event type, for validation and exhaustiveness tests. */
export const OFFICE_EVENT_TYPES = [
  'run.started',
  'run.finished',
  'work.received',
  'assignment.started',
  'assignment.finished',
  'assignment.failed',
  'handoff',
  'specialist.joined',
  'specialist.left',
  'artifact.created',
  'review.requested',
  'review.resolved',
  'blocked',
  'usage.reported',
  'note',
] as const;

// ---------------------------------------------------------------------------
// Floor plan
// ---------------------------------------------------------------------------

/**
 * World coordinates, in tile units. `x` runs east, `y` runs south, `z` is up.
 * The projection converts these to screen space; nothing outside `core/projection`
 * should care how.
 */
export type World = { x: number; y: number; z?: number };

export type Facing = 'n' | 'e' | 's' | 'w';

export type Room = {
  id: RoomId;
  label: string;
  origin: World;
  size: { w: number; h: number };
  /**
   * A department is a place work happens and can be drilled into; circulation is the
   * entrance and the corridors, which have no desks and no story of their own.
   *
   * Stated by the plan rather than inferred from "does it contain desks?", for the same
   * reason a handoff states its direction: a room that is *meant* to hold desks and
   * currently holds none is a real condition worth failing on, and inference would
   * silently turn that into "circulation".
   *
   * 'waiting' is where people with no desk of their own stand — subagents in a dynamic
   * office, who are on the floor from the moment they exist but are not seated anywhere
   * until their first assignment sends them somewhere.
   *
   * Defaults to 'department' when absent.
   */
  kind?: 'department' | 'circulation' | 'waiting';
};

/**
 * The furniture vocabulary a department can be built from.
 *
 * Six identical desks with six different labels is a diagram, not an office — you have
 * to read it to use it. Giving each department its own silhouette means you can tell the
 * workshop from the reading room across the floor, before any text loads, which is the
 * whole point of showing work as a place.
 *
 * Deliberately a small closed set: this is a company, not a furniture catalogue, and the
 * renderer has to be able to draw every one of them.
 */
export type PropKind =
  | 'cabinet' // tall filing drawers — records, archives
  | 'shelf' // bookshelf — reading, reference
  | 'screen' // a monitor or display board — research, dashboards
  | 'rack' // server rack — operations
  | 'bench' // low workbench — making things
  | 'stack' // stacked paper — drafting, correspondence
  | 'board' // whiteboard or pinboard — planning, review
  | 'plant' // a plant — softens a corner, no meaning
  | 'crate'; // storage crate — overflow, intake

export type StationProp = {
  kind: PropKind;
  /** Offset from the station's seat, in tile units. */
  at: World;
  /**
   * Which paint layer. `back` (the default) puts it behind whoever is at the desk;
   * `front` puts it between them and the viewer, which is how a low object reads as
   * being on the near side of the desk.
   */
  layer?: 'back' | 'front';
};

/**
 * A desk. Note the three tray positions: work arrives in `inTray`, is worked on at
 * `seat`, and leaves from `outTray`. Giving them distinct positions is what makes a
 * handoff read as a physical act rather than a value teleporting.
 */
export type Station = {
  id: StationId;
  room: RoomId;
  /** Display role — matches an `assignment.started.station`, and a specialist's `role`
   *  when the plan has a named desk for it. */
  role: string;
  seat: World;
  facing: Facing;
  /**
   * Where work arrives and leaves. Absent on a satellite desk: a satellite is somewhere to
   * work, not somewhere work is received, and drawing trays there would describe a handoff
   * that never happens at it.
   */
  inTray?: World;
  outTray?: World;
  /**
   * An additional desk in a department that already has one.
   *
   * A department used to BE a single desk, so several agents working at once were all sent
   * to the same coordinate and drawn inside one another. The first desk of a department is
   * never a satellite and keeps the department's own id, which is what producers name; the
   * satellites exist so that concurrent agents have somewhere of their own to sit, and are
   * deliberately not addressable from outside.
   */
  satellite?: true;
  /** Available to specialists whose role the plan does not name. Unknown-role arrivals
   *  take the lowest free hot desk, assigned by `seq` so replay matches live. */
  hotDesk?: boolean;
  /** Which aisle node this desk attaches to, for pathfinding. */
  node: AisleNodeId;
  /** What makes this department look like itself. Data, so the renderer stays generic. */
  props?: StationProp[];
};

export type Door = {
  id: string;
  at: World;
  facing: Facing;
  /** Specialists walk in and out through this door. Exactly one door per plan is. */
  entrance?: boolean;
};

export type AisleNode = { id: AisleNodeId; at: World };

/**
 * A walkable segment. `lanes` is how many folders can travel it side by side before
 * the renderer starts aggregating them into a single cart with a count badge — which
 * is what protects the art direction under burst load (PLAN.md A4).
 */
export type AisleEdge = { from: AisleNodeId; to: AisleNodeId; lanes: number };

/**
 * Paint layers a compiled plan emits. Order matters: within one depth, `station-back`
 * paints first, then anything walking through (`aisle`), then the seated worker, then
 * `station-front` — which is what occludes a worker behind their own desk.
 */
export type CompiledBandKind = 'station-back' | 'aisle' | 'station-seat' | 'station-front';

/**
 * Who is on the floor, and where they come from.
 *
 * `permanent` — the plan describes a standing team, and every non-hot desk is staffed for
 * the whole run. Right for a modelled workflow like lead reactivation, which really does
 * have six roles that all exist whether or not they are busy.
 *
 * `dynamic` — nobody is assumed. Workers appear when the stream first shows them doing
 * something and leave when it says they left, and they walk to whichever desk their
 * current assignment is at. Right for a live session, where the cast is whatever is
 * actually running: one agent, or one agent and five subagents. Hardcoding a roster there
 * would put people on the floor who do not exist.
 */
export type Staffing = 'permanent' | 'dynamic';

export type FloorPlan = {
  id: string;
  /** Bumped when geometry changes, so a recorded run can say which plan it expects. */
  version: number;
  label: string;
  /** Tile dimensions in screen px. 2:1 dimetric means `w` should be `2 * h`. */
  tile: { w: number; h: number; z: number };
  /** Defaults to `permanent` so existing plans keep their standing team. */
  staffing?: Staffing;
  rooms: Room[];
  stations: Station[];
  doors: Door[];
  aisle: { nodes: AisleNode[]; edges: AisleEdge[] };
  inbox: { at: World; node: AisleNodeId };
  outbox: { at: World; node: AisleNodeId };
  /** Set on a mobile variant to say which plan it is a restatement of. Station ids must
   *  match the parent so a run recorded on one renders on the other (PLAN.md A8). */
  variantOf?: string;
};

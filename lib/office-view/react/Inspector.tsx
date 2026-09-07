'use client';
/**
 * office-view/react/Inspector — the panel beside the floor.
 *
 * The floor is deliberately the lossy view: it answers "what is happening right now" and
 * can never answer "what has happened" or "what came out of it". This is the other half,
 * and it is why a run can be read back rather than only watched.
 *
 * It lives here, shared, because it existed twice — once on `/office` and once in the live
 * bridge — and the two had already drifted apart. The bridge had no artifacts panel and no
 * dossier at all, which is exactly backwards: a live session is where artifacts actually
 * appear. One component means the live view cannot fall behind the recorded one again.
 *
 * Everything below is derived from the event stream on every render. Nothing is stored and
 * nothing is summarised, so the panel cannot disagree with the office it sits beside; and
 * no label is re-phrased, because the strings shown are the producer's own.
 */

import { useMemo, useState } from 'react';

import { usageWorkerOf, workerOf } from '../core/attribution.ts';
import type { FloorPlan, OfficeEvent, StationId } from '../core/types.ts';
import type { Selection } from './OfficeView.tsx';

type ArtifactEvent = Extract<OfficeEvent, { type: 'artifact.created' }>;

/**
 * How far back each list reaches.
 *
 * A live session runs for hours and the DOM is not the place to keep all of it. Hitting
 * a cap is disclosed in the count line rather than silently truncated — a list that stops
 * at 500 without saying so reads as "that was everything".
 */
const MAX_OPERATIONS = 500;
const MAX_ARTIFACTS = 300;

export type InspectorProps = {
  plan: FloorPlan;
  events: readonly OfficeEvent[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /**
   * Show each operation's wall-clock time. True for a live session, where "when" is a real
   * question; false for a replay, where the clock on the wall is the clock at the time of
   * recording and would be actively misleading.
   */
  showClock?: boolean;
  /** What to say when the list is empty. A live office starts empty and should explain it. */
  emptyHint?: string;
  /** Finished agents the viewer has cleared off the floor. A view filter, never a deletion. */
  dismissed?: ReadonlySet<string>;
  onDismiss?: (worker: string) => void;
  onDismissAll?: (workers: readonly string[]) => void;
  onRestore?: () => void;
  /** Whether the floor is currently showing only agents that are doing something. */
  activeOnly?: boolean;
  onActiveOnly?: (only: boolean) => void;
  /**
   * Who the floor is drawing right now, and which of them are working.
   *
   * Supplied by the renderer rather than derived here, because the two questions are
   * different: this panel reads the whole event stream, the floor reads the timeline at
   * one instant. With "Only active" on they disagreed outright — an instant where the
   * floor drew one agent and the roster listed another. When it is absent (a host that
   * does not pass it) the roster falls back to describing the run, and says so.
   */
  cast?: {
    shown: readonly string[];
    working: readonly string[];
    finished: readonly string[];
  } | null;
};

/** Stable identity so a host that passes nothing does not re-render on every frame. */
const NO_DISMISSALS: ReadonlySet<string> = new Set();

export function Inspector({
  plan,
  events,
  selection,
  onSelect,
  showClock = false,
  emptyHint,
  dismissed = NO_DISMISSALS,
  onDismiss,
  onDismissAll,
  onRestore,
  activeOnly = false,
  onActiveOnly,
  cast = null,
}: InspectorProps) {
  const [tab, setTab] = useState<'operations' | 'artifacts'>('operations');

  /** The desks each department owns, so a department can be matched to its own work. */
  const roomStations = useMemo(() => {
    const byRoom = new Map<string, Set<StationId>>();
    for (const station of plan.stations) {
      if (!station.room) continue;
      const set = byRoom.get(station.room) ?? new Set<StationId>();
      set.add(station.id);
      byRoom.set(station.room, set);
    }
    return byRoom;
  }, [plan]);

  /**
   * Does this event belong to what is selected?
   *
   * A department is the union of its desks — nothing is aggregated or rephrased, the panel
   * still shows each desk's own words.
   */
  const matches = useMemo(() => {
    const desks = selection?.kind === 'department' ? roomStations.get(selection.id) : null;
    return (event: OfficeEvent) => {
      if (!selection) return true;
      if (selection.kind === 'station') return 'station' in event && event.station === selection.id;
      // Not `event.worker`: the main agent is named by omission, so a raw comparison
      // matched nothing for the one worker that did everything.
      if (selection.kind === 'worker') return workerOf(event) === selection.id;
      if (selection.kind === 'work') return 'work' in event && event.work?.id === selection.id;
      if (selection.kind === 'department') {
        if (!desks) return false;
        return 'station' in event && typeof event.station === 'string' && desks.has(event.station);
      }
      return true;
    };
  }, [selection, roomStations]);

  const operations = useMemo(() => {
    // Usage is a running meter rather than an operation. It has its own readout, and
    // including it here would bury the work under hundreds of token reports.
    const all = events.filter((event) => event.type !== 'usage.reported' && matches(event));
    // The total is kept alongside the slice so the count line can name what it is hiding.
    return { shown: all.slice(-MAX_OPERATIONS).reverse(), total: all.length };
  }, [events, matches]);

  /**
   * What the run produced, newest first.
   *
   * The office was very good at showing work happening and had no answer at all to "so
   * what came out of it". These are the producer's own names for the things it made.
   */
  const artifacts = useMemo(() => {
    const desks = selection?.kind === 'department' ? roomStations.get(selection.id) : null;
    const wanted = (event: ArtifactEvent) => {
      if (!selection) return true;
      if (selection.kind === 'station') return event.station === selection.id;
      if (selection.kind === 'department') return Boolean(desks) && desks!.has(event.station);
      if (selection.kind === 'work') return event.work?.id === selection.id;
      /*
       * A worker selection cannot narrow this. `artifact.created` records the DESK
       * something was made at, never the person who made it, so attributing one to
       * whoever happened to be standing there would be a guess. Everything is shown and
       * the panel says why, rather than quietly filtering on an inference.
       */
      return true;
    };
    const all = events
      .filter((event): event is ArtifactEvent => event.type === 'artifact.created')
      .filter(wanted);
    return { shown: all.slice(-MAX_ARTIFACTS).reverse(), total: all.length };
  }, [events, selection, roomStations]);

  /**
   * Who a selected person is, assembled only from what they actually did.
   *
   * Deliberately not a profile and deliberately not a voice: the role is the one the
   * producer stated when they joined, the counts are their own events, and the tokens are
   * their own attributed usage. Where the stream never said something, this says nothing.
   */
  const dossier = useMemo(() => {
    if (selection?.kind !== 'worker') return null;
    const id = selection.id;
    let role: string | null = null;
    let assignment: string | null = null;
    let assignments = 0;
    let failures = 0;
    let tokens = 0;
    let sawUsage = false;
    const desks = new Set<string>();

    for (const event of events) {
      if (event.type === 'specialist.joined' && event.worker === id) {
        role = event.role ?? null;
        assignment = event.detail ?? null;
      }
      if (workerOf(event) === id) {
        if (event.type === 'assignment.started') assignments += 1;
        if (event.type === 'assignment.failed') failures += 1;
        if ('station' in event && typeof event.station === 'string') desks.add(event.station);
      }
      if (event.type === 'usage.reported' && usageWorkerOf(event) === id) {
        sawUsage = true;
        tokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
      }
    }

    return {
      id,
      role,
      assignment,
      assignments,
      failures,
      desks: desks.size,
      // Absent usage is unknown, never zero — a zero would read as "this was free".
      tokens: sawUsage ? tokens : null,
    };
  }, [selection, events]);

  /**
   * Everyone the run has had, and whether they are still working.
   *
   * The only always-visible list of people either surface has. A finished agent stays on
   * the floor at the desk it used so its work can be reviewed, which makes "who is here,
   * and who has stopped" a question the panel now has to answer plainly.
   *
   * Derived from the stream, like everything else in this file: somebody exists because
   * they were seen working or announced, and they are finished because the producer said
   * so. Nothing is inferred from a timeout or a silence.
   */
  const roster = useMemo(() => {
    type Person = {
      id: string;
      role: string | null;
      left: boolean;
      /** Assignments started and not yet finished or failed. */
      open: number;
      /** The last action they were seen to START. */
      last: string | null;
      /** The last action they started that has not closed — what they are actually doing. */
      current: string | null;
      /** Which run they belong to, so one run ending does not silence another. */
      runId: string | null;
    };
    const people = new Map<string, Person>();

    for (const event of events) {
      /*
       * A run ending belongs to nobody, so it has to be handled BEFORE the `continue`
       * below. It was not: workerOf returns null for run.finished, so the clause that
       * closed everyone's work was unreachable and a finished session's agents went on
       * being listed as running for the rest of the stream.
       */
      if (event.type === 'run.finished') {
        for (const person of people.values()) {
          if (person.runId === event.runId) {
            person.open = 0;
            person.current = null;
          }
        }
        continue;
      }

      const id = workerOf(event);
      if (!id) continue;
      const person =
        people.get(id) ?? { id, role: null, left: false, open: 0, last: null, current: null, runId: null };
      person.runId = event.runId ?? person.runId;
      if (event.type === 'specialist.joined') person.role = event.role ?? person.role;
      if (event.type === 'assignment.started') {
        person.last = event.label;
        person.current = event.label;
        person.open += 1;
        // Working again after leaving is not a contradiction — a producer may re-use an
        // agent id — so the flag follows the most recent word.
        person.left = false;
      }
      /*
       * Closing an assignment is what makes somebody stop working, and nothing used to do
       * it. `last` was set when work STARTED and never cleared, and only `specialist.left`
       * could end a person's working state — which the main agent never emits. So the
       * roster listed the agent as working, with a violet hairline and its last tool as
       * the current action, for the whole run. That is the identical defect this change
       * set fixed in the scheduler, reproduced in the panel that was added to explain it.
       */
      if (event.type === 'assignment.finished' || event.type === 'assignment.failed') {
        person.open = Math.max(0, person.open - 1);
        /*
         * With nothing left open they are not doing anything, so nothing may be described
         * in the present tense. `last` survives — it is what they last DID — but `current`
         * is what the row is allowed to phrase as happening, and it goes with the work.
         */
        if (person.open === 0) person.current = null;
      }
      if (event.type === 'specialist.left') {
        person.left = true;
        person.open = 0;
      }
      people.set(id, person);
    }

    const all = [...people.values()];

    /*
     * When the floor has told us who it is drawing, that is the answer — a panel beside a
     * picture must not describe a different set of people from the picture.
     */
    const workingNow = cast ? new Set(cast.working) : null;
    const finishedNow = cast ? new Set(cast.finished) : null;
    if (workingNow && finishedNow) {
      for (const person of all) {
        person.open = workingNow.has(person.id) ? Math.max(1, person.open) : 0;
        if (!workingNow.has(person.id)) person.current = null;
        /*
         * And whether they have finished AT THIS INSTANT. Derived from the stream, the flag
         * meant "leaves at some point in this run", so an agent was treated as finished at
         * every earlier moment too — the floor drew them working while the roster filed
         * them under finished and, with "Only active" on, dropped them entirely.
         */
        person.left = finishedNow.has(person.id);
      }
    }

    return {
      working: all.filter((person) => !person.left),
      finished: all.filter((person) => person.left && !dismissed.has(person.id)),
      clearedCount: all.filter((person) => person.left && dismissed.has(person.id)).length,
      /** True when these states describe the instant on screen rather than the whole run. */
      live: workingNow !== null,
    };
  }, [events, dismissed, cast]);

  /** What the panel is scoped to, in the plan's own words. */
  const scope = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'department') {
      const room = plan.rooms.find((candidate) => candidate.id === selection.id);
      const count = roomStations.get(selection.id)?.size ?? 0;
      return room ? `${room.label} · ${count} ${count === 1 ? 'desk' : 'desks'}` : null;
    }
    if (selection.kind === 'station') {
      const station = plan.stations.find((candidate) => candidate.id === selection.id);
      return station ? `${station.role} desk` : selection.id;
    }
    if (selection.kind === 'worker') return selection.id === 'main' ? 'The agent' : selection.id;
    return 'One unit of work';
  }, [selection, plan, roomStations]);

  const list = tab === 'operations' ? operations : artifacts;
  const noun = tab === 'operations' ? 'operation' : 'artifact';
  /*
   * A capped list names the total it is a tail of. "last 500 of 500" would be worse than
   * silence — it reads as a total — so the number quoted here is every match, not the
   * slice being rendered.
   */
  const capped = list.shown.length < list.total;

  return (
    <aside className="oi" aria-label="Inspector">
      <div className="oi-head">
        <strong>{scope ?? 'Everything'}</strong>
        {selection ? (
          <button type="button" onClick={() => onSelect(null)}>
            Show everything
          </button>
        ) : null}
      </div>

      {/* A person, described by what they did rather than given a voice. */}
      {dossier ? (
        <div className="oi-dossier">
          <p className="oi-dossier-role">
            {dossier.role ?? (dossier.id === 'main' ? 'The agent' : 'Role not stated')}
            {dossier.assignment ? <span> · {dossier.assignment}</span> : null}
          </p>
          <dl>
            <div>
              <dt>Assignments</dt>
              <dd>{dossier.assignments}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd>{dossier.failures}</dd>
            </div>
            <div>
              <dt>Desks used</dt>
              <dd>{dossier.desks}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              {/* Unknown is a real answer here; a zero would read as "this was free". */}
              <dd>{dossier.tokens === null ? 'not reported' : dossier.tokens.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {/*
        * Everyone this run has had. Like the operations and artifact lists beside it, this
        * describes the WHOLE run rather than the instant the floor is showing — a scrub
        * back to the first second would otherwise empty a panel whose job is to let you
        * read what happened. It is headed accordingly: "on the floor" would be a claim
        * about right now, and at t=1s it would be false.
        */}
      {roster.working.length + roster.finished.length + roster.clearedCount > 0 ? (
        <div className="oi-roster">
          <div className="oi-roster-head">
            <span>People in this run</span>
            {onActiveOnly ? (
              <button
                type="button"
                className={activeOnly ? 'is-on' : ''}
                aria-pressed={activeOnly}
                onClick={() => onActiveOnly(!activeOnly)}
                title="Show only the agents with something running right now"
              >
                {activeOnly ? 'Showing active only' : 'Only active'}
              </button>
            ) : null}
            {onDismissAll && roster.finished.length > 0 ? (
              <button
                type="button"
                onClick={() => onDismissAll(roster.finished.map((person) => person.id))}
                title="Clear every finished agent off the floor. Nothing is deleted."
              >
                Clear finished ({roster.finished.length})
              </button>
            ) : null}
          </div>

          <ul>
            {(activeOnly
              ? roster.working.filter((person) => person.open > 0)
              : [...roster.working, ...roster.finished]
            ).map((person) => (
              <li
                key={person.id}
                className={
                  person.left ? 'is-finished' : person.open > 0 ? 'is-working' : 'is-idle'
                }
              >
                <button type="button" onClick={() => onSelect({ kind: 'worker', id: person.id })}>
                  <span className="oi-roster-who">
                    {person.id === 'main' ? 'The agent' : person.id}
                  </span>
                  {/* The producer's own last words, never "idle" or "done" — the office
                      reports what was said, and nobody said those. */}
                  {/*
                    * Three states, and the wording keeps them apart. Only an open
                    * assignment is described in the present tense; anything else quotes the
                    * LAST thing the producer said, labelled as last. Nobody is ever called
                    * "idle" or "done" — the producer never said either.
                    */}
                  <span className="oi-roster-what">
                    {person.left
                      ? `finished${person.last ? ` · last: ${person.last}` : ''}`
                      : person.open > 0 && person.current
                        ? person.current
                        : person.last
                          ? `last: ${person.last}`
                          : (person.role ?? 'no action reported yet')}
                  </span>
                </button>
                {person.left && onDismiss ? (
                  <button
                    type="button"
                    className="oi-roster-clear"
                    onClick={() => onDismiss(person.id)}
                    aria-label={`Clear ${person.id} off the floor`}
                    title="Clear this record off the floor. Nothing is deleted."
                  >
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {/*
            * Permanently stated and deliberately not dismissible. An office that reported
            * less after you tidied it, without saying so, would be exactly the kind of
            * quiet subtraction this project exists not to do.
            */}
          {/*
            * The filter states itself, and states what it is keeping back. A view that
            * quietly showed fewer people than are on the floor would be the same
            * subtraction the cleared line exists to refuse.
            */}
          {activeOnly ? (
            <p className="oi-cleared">
              {roster.working.filter((person) => person.open === 0).length + roster.finished.length}{' '}
              hidden ·{' '}
              {roster.live
                ? 'showing only agents with something running'
                : 'showing only agents that worked at some point — this run, not this moment'}
              {onActiveOnly ? (
                <button type="button" onClick={() => onActiveOnly(false)}>
                  Show everyone
                </button>
              ) : null}
            </p>
          ) : null}

          {roster.clearedCount > 0 ? (
            <p className="oi-cleared">
              {roster.clearedCount} cleared from the floor · still in the log
              {onRestore ? (
                <button type="button" onClick={onRestore}>
                  Put back
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="oi-tabs" role="tablist" aria-label="What to show">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'operations'}
          className={tab === 'operations' ? 'is-on' : ''}
          onClick={() => setTab('operations')}
        >
          Operations ({operations.total.toLocaleString()})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'artifacts'}
          className={tab === 'artifacts' ? 'is-on' : ''}
          onClick={() => setTab('artifacts')}
        >
          Produced ({artifacts.total.toLocaleString()})
        </button>
      </div>

      {/* Says when the list is capped, so a truncated view is never mistaken for the whole. */}
      <p className="oi-count">
        {capped ? `last ${list.shown.length.toLocaleString()} of ` : ''}
        {list.total.toLocaleString()} {list.total === 1 ? noun : `${noun}s`}
        {selection ? ' here' : ''}
      </p>

      {tab === 'operations' ? (
        operations.total === 0 ? (
          <p className="oi-note">{emptyHint ?? 'Nothing here yet.'}</p>
        ) : (
          <ol className="oi-list">
            {operations.shown.map((event) => (
              <li key={event.id} className={`is-${event.type.split('.')[1] ?? event.type}`}>
                <span className="oi-meta">
                  {'station' in event && event.station ? String(event.station) : '—'}
                  {showClock ? (
                    <>
                      {' · '}
                      {new Date(event.occurredAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </>
                  ) : null}
                </span>
                {/* The producer's own words. Never re-phrased, never summarised. */}
                <span className="oi-label">{event.label}</span>
                {event.detail ? <span className="oi-detail">{event.detail}</span> : null}
              </li>
            ))}
          </ol>
        )
      ) : artifacts.total === 0 ? (
        <p className="oi-note">
          Nothing was produced here. Plenty of runs make no artifact at all, and saying so is
          the answer.
        </p>
      ) : (
        <>
          {selection?.kind === 'worker' ? (
            <p className="oi-note">
              Artifacts record the desk they were made at, not the person — so this is
              everything produced, not just theirs.
            </p>
          ) : null}
          <ol className="oi-list">
            {artifacts.shown.map((event) => (
              <li key={event.id} className="is-created">
                <span className="oi-meta">
                  {event.artifact.kind} · {event.station}
                </span>
                <span className="oi-label">{event.artifact.name}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

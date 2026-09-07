'use client';
/**
 * /office — the office itself.
 *
 * This route used to be the lead-reactivation product, which meant the nav item labelled
 * "The office" opened on "Good leads deserve a second conversation" and the renderer was
 * one tab among three. The thing the whole project is named after was a sub-feature of its
 * own demo. The lead workflow now lives at /office/leads, and this is the office: a floor
 * you can watch, scrub, drill into, and read back.
 *
 * It runs a committed recording rather than a live session, and says so. The live path is
 * the bridge — see CONNECT.md — and it renders this same office from the same contract.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Layers3, Pause, Play, Terminal } from 'lucide-react';

import { OfficeStage } from '@/lib/office-view/three/OfficeStage';
import { OfficeView, type Selection } from '@/lib/office-view/react/OfficeView';
import { codingSessionPlan } from '@/lib/floorplans/coding-session';
import { leadReactivationPlan } from '@/lib/floorplans/lead-reactivation';
import recordedCodingRun from '@/fixtures/recorded-coding-run.json';
import recordedLeadRun from '@/fixtures/recorded-lead-run.json';
import type { OfficeEvent } from '@/lib/office-view/core/types';
import './office-page.css';

type RunName = 'coding' | 'lead';

/** The two committed recordings, each carrying its own account of what it is. */
const RUNS = {
  coding: {
    label: 'A coding session',
    plan: codingSessionPlan,
    events: recordedCodingRun.events as unknown as OfficeEvent[],
    provenance: recordedCodingRun.provenance,
    stamp: 'Recorded run · real Claude Code session · reconstructed, redacted',
  },
  lead: {
    label: 'A lead workflow',
    plan: leadReactivationPlan,
    events: recordedLeadRun.events as unknown as OfficeEvent[],
    provenance: recordedLeadRun.provenance,
    stamp: 'Recorded run · lead reactivation · fictional sample',
  },
} as const;

export default function OfficePage() {
  const [runName, setRunName] = useState<RunName>('coding');
  const [threeD, setThreeD] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(4);
  const [seek, setSeek] = useState<number | null>(null);
  const [progress, setProgress] = useState({ t: 0, duration: 1 });
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<'operations' | 'artifacts'>('operations');
  const [presenting, setPresenting] = useState(false);

  const run = RUNS[runName];
  const events = useMemo(() => run.events, [run]);

  /** The desks each department owns, so a department can be matched to its own work. */
  const roomStations = useMemo(() => {
    const byRoom = new Map<string, Set<string>>();
    for (const station of run.plan.stations) {
      if (!station.room) continue;
      const set = byRoom.get(station.room) ?? new Set<string>();
      set.add(station.id);
      byRoom.set(station.room, set);
    }
    return byRoom;
  }, [run.plan]);

  /**
   * Everything that happened, newest first, narrowed to whatever is selected.
   *
   * The floor is the lossy view on purpose — it shows what is happening at an instant.
   * This is the other half, and it is why a run can be read rather than only watched.
   */
  const operations = useMemo(() => {
    const desks = selection?.kind === 'department' ? roomStations.get(selection.id) : null;
    const wanted = (event: OfficeEvent) => {
      if (!selection) return true;
      if (selection.kind === 'station') return 'station' in event && event.station === selection.id;
      if (selection.kind === 'worker') return 'worker' in event && event.worker === selection.id;
      if (selection.kind === 'work') return 'work' in event && event.work?.id === selection.id;
      if (selection.kind === 'department') {
        return Boolean(desks) && 'station' in event && typeof event.station === 'string'
          ? desks!.has(event.station)
          : false;
      }
      return true;
    };
    // Usage is a running meter, not an operation; it has its own readout and would drown
    // the log.
    return events.filter((event) => event.type !== 'usage.reported' && wanted(event)).slice(-500).reverse();
  }, [events, selection, roomStations]);

  /**
   * Who a selected person is, assembled from what they actually did.
   *
   * Deliberately not a profile: the role is the one the producer stated when they joined,
   * the counts are their own events, and the tokens are their own attributed usage. If the
   * stream never said something, this says nothing rather than filling it in.
   */
  const dossier = useMemo(() => {
    if (selection?.kind !== 'worker') return null;
    const id = selection.id;
    let role: string | null = null;
    let assignment: string | null = null;
    let assignments = 0;
    let failures = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    const desks = new Set<string>();

    for (const event of events) {
      if (event.type === 'specialist.joined' && event.worker === id) {
        role = event.role ?? null;
        assignment = event.detail ?? null;
      }
      if ('worker' in event && event.worker === id) {
        if (event.type === 'assignment.started') assignments += 1;
        if (event.type === 'assignment.failed') failures += 1;
        if ('station' in event && typeof event.station === 'string') desks.add(event.station);
      }
      if (event.type === 'usage.reported' && event.usage.worker === id) {
        sawUsage = true;
        inputTokens += event.usage.inputTokens ?? 0;
        outputTokens += event.usage.outputTokens ?? 0;
      }
    }

    return {
      id,
      role,
      assignment,
      assignments,
      failures,
      desks: [...desks],
      // Absent usage is reported as unknown, never as zero — a zero would read as "free".
      tokens: sawUsage ? inputTokens + outputTokens : null,
    };
  }, [selection, events]);

  /**
   * What the run produced: every artifact, newest first, narrowed like the log.
   *
   * The office is very good at showing work happening and had no answer at all to "so
   * what came out of it". These are the producer's own names for the things it made.
   */
  const artifacts = useMemo(() => {
    const desks = selection?.kind === 'department' ? roomStations.get(selection.id) : null;
    const made = events.filter(
      (event): event is Extract<OfficeEvent, { type: 'artifact.created' }> =>
        event.type === 'artifact.created',
    );
    const wanted = (event: Extract<OfficeEvent, { type: 'artifact.created' }>) => {
      if (!selection) return true;
      if (selection.kind === 'station') return event.station === selection.id;
      if (selection.kind === 'department') return Boolean(desks) && desks!.has(event.station);
      if (selection.kind === 'work') return event.work?.id === selection.id;
      /*
       * A worker selection cannot narrow this. `artifact.created` records the DESK
       * something was made at, not the person who made it, so attributing an artifact to
       * whoever happened to be standing there would be a guess. Everything is shown, and
       * the panel says why rather than quietly filtering on an inference.
       */
      return true;
    };
    return made.filter(wanted).slice(-300).reverse();
  }, [events, selection, roomStations]);

  /** What the log is scoped to, in the plan's own words. */
  const scope = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'department') {
      const room = run.plan.rooms.find((candidate) => candidate.id === selection.id);
      const desks = roomStations.get(selection.id);
      return room ? `${room.label} · ${desks?.size ?? 0} ${desks?.size === 1 ? 'desk' : 'desks'}` : null;
    }
    if (selection.kind === 'station') {
      const station = run.plan.stations.find((candidate) => candidate.id === selection.id);
      return station ? `${station.role} desk` : selection.id;
    }
    if (selection.kind === 'worker') return selection.id === 'main' ? 'The agent' : selection.id;
    return 'One unit of work';
  }, [selection, run.plan, roomStations]);

  /** The departments, in plan order, so the number keys mean something stable. */
  const departments = useMemo(
    () => run.plan.rooms.filter((room) => (room.kind ?? 'department') === 'department'),
    [run.plan],
  );

  const step = useCallback(
    (direction: number) => {
      // Five per cent of the run per press: fine enough to land on a moment, coarse enough
      // to cross a long session without holding the key down for a minute.
      const delta = Math.max(250, progress.duration * 0.05) * direction;
      setSeek(Math.min(progress.duration, Math.max(0, progress.t + delta)));
    },
    [progress],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never steal a key from someone typing.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key;
      if (key === ' ') {
        event.preventDefault();
        setPlaying((on) => !on);
      } else if (key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (key === 'Escape') {
        // One key backs out of whatever you are in, innermost first.
        if (presenting) setPresenting(false);
        else setSelection(null);
      } else if (key === 'r' || key === 'R') {
        setThreeD((on) => !on);
      } else if (key === 'p' || key === 'P') {
        setPresenting((on) => !on);
      } else if (key === 'd' || key === 'D') {
        /*
         * Until someone chooses, the OS decides — `data-theme` is simply absent and the
         * prefers-color-scheme rules apply. Pressing D is that choice, and it sticks.
         */
        const root = document.documentElement;
        const current =
          root.dataset.theme ??
          (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = current === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try {
          window.localStorage.setItem('o6-theme', next);
        } catch {
          // A browser refusing storage is not a reason to refuse the theme.
        }
      } else if (/^[1-9]$/.test(key)) {
        const room = departments[Number(key) - 1];
        if (room) setSelection({ kind: 'department', id: room.id });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [departments, presenting, step]);

  const stageProps = {
    plan: run.plan,
    events,
    modeLabel: run.stamp,
    playing,
    speed,
    seekMs: seek,
    selection,
    onSelect: setSelection,
    onTime: (t: number, duration: number) => setProgress({ t, duration }),
  };

  if (presenting) {
    /*
     * Everything except the floor. The compression stamp stays — it lives inside the
     * renderer, and a presentation is exactly when a viewer is most likely to take the
     * pacing at face value.
     */
    return (
      <main className="office-page is-presenting">
        <div className="office-page-floor">
          {threeD ? <OfficeStage {...stageProps} /> : <OfficeView {...stageProps} />}
        </div>
        <p className="office-page-presenting-hint">
          {run.stamp} · press P or Esc to come back
        </p>
      </main>
    );
  }

  return (
    <main className="office-page">
      <header className="office-page-top">
        <a className="brand" href="/" aria-label="O6 Invention Lab home">
          <b>O6</b> office<span>.</span>
        </a>
        <nav>
          <a href="/office/leads">
            Run a lead workflow <ArrowUpRight size={13} />
          </a>
          <a href="https://github.com/Aaltaye/o6-office/blob/main/CONNECT.md" rel="noreferrer" target="_blank">
            Connect your own agent <ArrowUpRight size={13} />
          </a>
        </nav>
      </header>

      <div className="office-page-controls">
        <div className="office-page-runs" role="tablist" aria-label="Which recording">
          {(Object.keys(RUNS) as RunName[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={runName === key}
              className={runName === key ? 'is-on' : ''}
              onClick={() => {
                // A selection from one floor plan means nothing on the other.
                setSelection(null);
                setSeek(0);
                setRunName(key);
              }}
            >
              {key === 'coding' ? <Terminal size={14} /> : <Layers3 size={14} />}
              {RUNS[key].label}
            </button>
          ))}
        </div>

        <button type="button" className="office-page-play" onClick={() => setPlaying((on) => !on)}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
          {playing ? 'Pause' : 'Play'}
        </button>

        <label className="office-page-speed">
          Speed
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {[1, 2, 4, 8, 14].map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
        </label>

        <label className="office-page-toggle">
          <input type="checkbox" checked={threeD} onChange={(event) => setThreeD(event.target.checked)} />
          3D
        </label>

        <button
          type="button"
          className="office-page-play"
          onClick={() => setPresenting(true)}
          title="Hide every control and just play the office (P)"
        >
          Present
        </button>

        <span className="office-page-clock">
          {(progress.t / 1000).toFixed(0)}s / {(progress.duration / 1000).toFixed(0)}s of the
          compressed timeline
        </span>
      </div>

      {/* Scrubbing is the point of the timeline architecture — dragging backwards is
          exactly as correct as playing forwards. */}
      <input
        type="range"
        className="office-page-scrub"
        min={0}
        max={progress.duration}
        value={progress.t}
        onChange={(event) => setSeek(Number(event.target.value))}
        aria-label="Scrub the run"
      />

      <div className="office-page-body">
        <div className="office-page-floor">
          {threeD ? <OfficeStage {...stageProps} /> : <OfficeView {...stageProps} />}
        </div>

        <aside className="office-page-log" aria-label="Operations">
          <div className="office-page-log-head">
            <strong>{scope ?? 'Everything'}</strong>
            {selection ? (
              <button type="button" onClick={() => setSelection(null)}>
                Show everything
              </button>
            ) : null}
          </div>

          {/* A person, described by what they did rather than given a voice. */}
          {dossier ? (
            <div className="office-page-dossier">
              <p className="office-page-dossier-role">
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
                  <dd>{dossier.desks.length}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  {/* Unknown is a real answer here; a zero would read as "this was free". */}
                  <dd>{dossier.tokens === null ? 'not reported' : dossier.tokens.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          <div className="office-page-panel-tabs" role="tablist" aria-label="What to show">
            {(['operations', 'artifacts'] as const).map((which) => (
              <button
                key={which}
                type="button"
                role="tab"
                aria-selected={panel === which}
                className={panel === which ? 'is-on' : ''}
                onClick={() => setPanel(which)}
              >
                {which === 'operations' ? `Operations (${operations.length})` : `Produced (${artifacts.length})`}
              </button>
            ))}
          </div>

          {panel === 'operations' ? (
            <ol className="office-page-log-list">
              {operations.map((event) => (
                <li key={event.id} className={`is-${event.type.split('.')[1] ?? event.type}`}>
                  <span className="office-page-op-meta">
                    {'station' in event && event.station ? String(event.station) : '—'}
                  </span>
                  {/* The producer's own words. Never re-phrased, never summarised. */}
                  <span className="office-page-op-label">{event.label}</span>
                  {event.detail ? <span className="office-page-op-detail">{event.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : artifacts.length === 0 ? (
            <p className="office-page-log-count">
              Nothing was produced here. Plenty of runs make no artifact at all, and saying so
              is the answer.
            </p>
          ) : (
            <>
              {selection?.kind === 'worker' ? (
                <p className="office-page-log-count">
                  Artifacts record the desk they were made at, not the person — so this is
                  everything the run produced, not just theirs.
                </p>
              ) : null}
              <ol className="office-page-log-list">
                {artifacts.map((event) => (
                  <li key={event.id} className="is-created">
                    <span className="office-page-op-meta">
                      {event.artifact.kind} · {event.station}
                    </span>
                    <span className="office-page-op-label">{event.artifact.name}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </aside>
      </div>

      <p className="office-page-keys">
        <kbd>space</kbd> play · <kbd>←</kbd> <kbd>→</kbd> scrub · <kbd>1</kbd>–
        <kbd>{String(Math.min(9, departments.length))}</kbd> department · <kbd>R</kbd> renderer ·{' '}
        <kbd>P</kbd> present · <kbd>D</kbd> dark · <kbd>Esc</kbd> back
      </p>

      {/* Quoted from the recording's metadata, so this page cannot claim more for a
          fixture than the fixture claims for itself. */}
      <p className="office-page-provenance">{run.provenance}</p>
    </main>
  );
}

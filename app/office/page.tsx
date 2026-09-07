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

import { useMemo, useState } from 'react';
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
            <strong>{scope ?? 'All operations'}</strong>
            {selection ? (
              <button type="button" onClick={() => setSelection(null)}>
                Show everything
              </button>
            ) : null}
          </div>
          <p className="office-page-log-count">
            {operations.length} {operations.length === 1 ? 'operation' : 'operations'}
            {selection ? ' here' : ' in this run'} · click a desk or a department
          </p>
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
        </aside>
      </div>

      {/* Quoted from the recording's metadata, so this page cannot claim more for a
          fixture than the fixture claims for itself. */}
      <p className="office-page-provenance">{run.provenance}</p>
    </main>
  );
}

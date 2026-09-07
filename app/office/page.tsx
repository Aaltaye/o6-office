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
import { Inspector } from '@/lib/office-view/react/Inspector';
import { useDismissed } from '@/lib/office-view/react/useDismissed';
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
  const [presenting, setPresenting] = useState(false);

  // Scoped per run, so tidying one recording does not tidy the other.
  const { dismissed, dismiss, dismissAll, restoreAll } = useDismissed(`office:${runName}`);

  const run = RUNS[runName];
  const events = useMemo(() => run.events, [run]);

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
    // Cleared records leave the floor as well as the roster; the count stays stated.
    dismissed,
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

        <Inspector
          plan={run.plan}
          events={events}
          selection={selection}
          onSelect={setSelection}
          dismissed={dismissed}
          onDismiss={dismiss}
          onDismissAll={dismissAll}
          onRestore={restoreAll}
        />
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

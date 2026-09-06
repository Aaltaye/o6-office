'use client';
/**
 * /lab — a development harness for the office renderer.
 *
 * Deliberately separate from the product page. The renderer is developed and verified
 * here against hand-written streams so it is provable *before* any workflow is wired
 * into it, and so the awkward cases (a reviewer sending work back, a burst of genuinely
 * simultaneous handoffs) always have somewhere to live.
 *
 * This page is not the product. `app/page.tsx` mounts the office for real in T004.
 */

import { useMemo, useState } from 'react';

import { OfficeView, type Selection } from '@/lib/office-view/react/OfficeView';
import { demoLeadRun, demoBurst } from '@/lib/office-view/dev/demo-stream';
import {
  leadReactivationPlan,
  leadReactivationCompactPlan,
} from '@/lib/floorplans/lead-reactivation';

type StreamName = 'lead-run' | 'burst';

export default function LabPage() {
  const [streamName, setStreamName] = useState<StreamName>('lead-run');
  const [compact, setCompact] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [seek, setSeek] = useState<number | null>(null);
  const [progress, setProgress] = useState({ t: 0, duration: 1 });
  const [selection, setSelection] = useState<Selection>(null);

  const events = useMemo(
    () => (streamName === 'burst' ? demoBurst() : demoLeadRun()),
    [streamName],
  );
  const plan = compact ? leadReactivationCompactPlan : leadReactivationPlan;

  return (
    <main style={{ padding: 20, fontFamily: 'var(--font-geist-sans, system-ui)' }}>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, margin: 0, letterSpacing: '-0.02em' }}>Office renderer — lab</h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
          Development harness. Streams here are synthetic and labelled as such.
        </p>
      </header>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <select
          value={streamName}
          onChange={(event) => {
            setStreamName(event.target.value as StreamName);
            setSeek(0);
          }}
          aria-label="Event stream"
        >
          <option value="lead-run">Lead run (includes the carried-back beat)</option>
          <option value="burst">Burst — 6 simultaneous handoffs</option>
        </select>

        <button type="button" onClick={() => setPlaying((value) => !value)}>
          {playing ? 'Pause' : 'Play'}
        </button>

        <button type="button" onClick={() => setSeek(0)}>
          Restart
        </button>

        <label style={{ fontSize: 13 }}>
          Speed
          <select
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            style={{ marginLeft: 6 }}
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
        </label>

        <label style={{ fontSize: 13 }}>
          <input
            type="checkbox"
            checked={compact}
            onChange={(event) => setCompact(event.target.checked)}
          />{' '}
          Compact (mobile) plan
        </label>

        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {(progress.t / 1000).toFixed(1)}s / {(progress.duration / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Scrubbing is the point of the timeline architecture — dragging backwards has to
          be exactly as correct as playing forwards. */}
      <input
        type="range"
        min={0}
        max={progress.duration}
        value={progress.t}
        onChange={(event) => setSeek(Number(event.target.value))}
        aria-label="Scrub the run"
        style={{ width: '100%', marginBottom: 12 }}
      />

      <div style={{ height: '68vh', border: '1px solid #e5e8ef', borderRadius: 12, overflow: 'hidden' }}>
        <OfficeView
          plan={plan}
          events={events}
          modeLabel="Synthetic stream · lab"
          playing={playing}
          speed={speed}
          seekMs={seek}
          selection={selection}
          onSelect={(next) => {
            setSelection(next);
            setSeek(null);
          }}
          onTime={(t, duration) => {
            setProgress({ t, duration });
            // Release the controlled seek once playback has taken over again.
            if (seek !== null && Math.abs(t - seek) > 50) setSeek(null);
          }}
        />
      </div>

      <p style={{ marginTop: 10, fontSize: 13, color: '#374151' }}>
        Selected: <code>{selection ? `${selection.kind}:${selection.id}` : 'nothing'}</code>
      </p>
    </main>
  );
}

'use client';
/**
 * The O6 Invention Lab.
 *
 * The office by itself is a demo. This page is what makes it an argument: it says what
 * the Lab is for, what this experiment is trying to prove, and what the rules are — and
 * it opens with the office actually running, because the fastest way to explain "make
 * invisible work visible" is to show somebody invisible work, made visible.
 *
 * The hero plays the committed recording of a real run. Not a video, not a mock-up: the
 * same renderer, the same event contract, the same rules as the product itself.
 */

import { useMemo, useState } from 'react';
import { ArrowRight, Play, ShieldCheck, Terminal, Layers3 } from 'lucide-react';

import { OfficeStage } from '@/lib/office-view/three/OfficeStage';
import { leadReactivationPlan } from '@/lib/floorplans/lead-reactivation';
import { codingSessionPlan } from '@/lib/floorplans/coding-session';
import recordedLeadRun from '@/fixtures/recorded-lead-run.json';
import recordedCodingRun from '@/fixtures/recorded-coding-run.json';
import type { OfficeEvent } from '@/lib/office-view/core/types';
import './lab-home.css';

type Mode = 'lead' | 'coding';

/** What each mode is, in the words a visitor needs rather than the words we use. */
const MODES = {
  lead: {
    label: 'Run your work',
    plan: leadReactivationPlan,
    events: recordedLeadRun.events as unknown as OfficeEvent[],
    stamp: 'Recorded run · lead reactivation · fictional sample',
    speed: 1.6,
    title: 'Give the office a job',
    body:
      'Hand it a CSV of old enquiries. It works out which conversations are worth reopening, ' +
      'why, and what to say — and you watch it decide, desk by desk.',
  },
  coding: {
    label: 'Connect your work',
    plan: codingSessionPlan,
    events: recordedCodingRun.events as unknown as OfficeEvent[],
    stamp: 'Recorded run · a real Claude Code session',
    // A 23-minute session, so the hero runs it fast. Playback speed only: the order and
    // the relative timing of everything that happened are untouched.
    speed: 14,
    title: 'Or point it at your own agents',
    body:
      'One command runs a local bridge. Your Claude Code session streams into the same ' +
      'office: every tool call, every subagent walking in, every token — and none of it ' +
      'leaves your machine.',
  },
} as const;

export default function LabHome() {
  const [mode, setMode] = useState<Mode>('lead');
  const current = MODES[mode];
  // Both recordings are static imports; memoising keeps the scheduler from re-running
  // on every render of this page.
  const events = useMemo(() => current.events, [current]);

  return (
    <main className="lab">
      <header className="lab-top">
        <span className="lab-brand">
          <b>O6</b> <span>invention lab</span>
        </span>
        <nav className="lab-nav">
          <a href="/office">The office</a>
          <a href="https://github.com/Aaltaye/o6-office" rel="noreferrer" target="_blank">
            Source
          </a>
        </nav>
      </header>

      <section className="lab-hero">
        <div className="lab-hero-copy">
          <span className="lab-eyebrow">O6 Applied · Invention Lab</span>
          <h1>
            Make invisible <em>work</em> visible.
          </h1>
          <p className="lab-lede">
            Agents do an enormous amount of work that nobody can see. Logs are for engineers;
            a spinner tells you nothing. So we built an office you can watch — desks,
            handoffs, a specialist called in for one job, and a reviewer who sends work back.
          </p>
          <div className="lab-actions">
            <a className="lab-button primary" href="/office">
              <Play size={15} /> Open the office
            </a>
            <a className="lab-button" href="#how">
              How it works <ArrowRight size={15} />
            </a>
          </div>
        </div>

        {/* The office, actually running. A screenshot would have been easier and would
            have proved nothing. */}
        <div className="lab-stage">
          <OfficeStage
            plan={current.plan}
            events={events}
            modeLabel={current.stamp}
            playing
            speed={current.speed}
          />
        </div>
      </section>

      <section className="lab-modes" id="how">
        <div className="lab-mode-switch" role="tablist" aria-label="Which kind of work">
          {(Object.keys(MODES) as Mode[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              className={mode === key ? 'is-on' : ''}
              onClick={() => setMode(key)}
            >
              {key === 'lead' ? <Layers3 size={15} /> : <Terminal size={15} />}
              {MODES[key].label}
            </button>
          ))}
        </div>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        <p className="lab-note">
          The office above is showing this mode — a real recorded run, not a video.
        </p>
      </section>

      <section className="lab-rules">
        <span className="lab-eyebrow">
          <ShieldCheck size={14} /> The rules it follows
        </span>
        <h2>What you see is what happened.</h2>
        <p className="lab-lede">
          A visualisation of work is only worth anything if you can trust it. These are
          enforced in code, as assertions that fail the build — not written down and hoped for.
        </p>
        <ul className="lab-rule-list">
          <li>
            <strong>Labels are literal.</strong> “Reviewing draft against source notes”, or a
            tool’s own name and file. Never an invented account of what an agent was thinking.
          </li>
          <li>
            <strong>Nothing is animated that did not happen.</strong> If something moves with no
            event to justify the journey, it cuts rather than walks. A cut is an honest
            ellipsis; a walk is a claim.
          </li>
          <li>
            <strong>Simultaneous stays simultaneous.</strong> Parallel tool calls are concurrent.
            A queue would show you a sequence that never occurred.
          </li>
          <li>
            <strong>Compression is stated.</strong> When time is compressed or items are batched,
            the office says so on screen.
          </li>
          <li>
            <strong>“Unavailable” is a real answer.</strong> Local mode reports no tokens because
            it spent none. A confident zero would read as “this was free”.
          </li>
          <li>
            <strong>Only what is live is on the floor.</strong> One agent means one figure. Six
            subagents means six. There is no roster and no cap.
          </li>
        </ul>
      </section>

      <section className="lab-next">
        <span className="lab-eyebrow">The lab</span>
        <h2>Experiment 001 of a series.</h2>
        <p className="lab-lede">
          The theme is making familiar work legible by giving it a form people already know.
          The office is the first one.
        </p>
        <div className="lab-cards">
          <article className="lab-card is-built">
            <span className="lab-card-tag">Built</span>
            <h3>001 · The Office</h3>
            <p>
              Agentic work as a place. Watch a workflow run, or stream your own coding session
              into the same floor.
            </p>
            <a href="/office">
              Open it <ArrowRight size={14} />
            </a>
          </article>
          {/* Stated as ideas, not as roadmap. Nothing here is built, and saying otherwise
              on the page whose whole subject is honesty would be a poor start. */}
          <article className="lab-card">
            <span className="lab-card-tag">Idea</span>
            <h3>The Spreadsheet City</h3>
            <p>
              A business’s numbers as a city, where bottlenecks look like traffic and the
              busiest streets are the ones costing the most.
            </p>
          </article>
          <article className="lab-card">
            <span className="lab-card-tag">Idea</span>
            <h3>The Walkable Business Plan</h3>
            <p>
              A plan you move through rather than read, where every assumption is a door and
              the dependencies are corridors.
            </p>
          </article>
        </div>
      </section>

      <footer className="lab-foot">
        <span>O6 Applied · Invention Lab</span>
        <span>Experiment 001 · a working prototype, not a product</span>
      </footer>
    </main>
  );
}

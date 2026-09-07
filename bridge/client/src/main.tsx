/**
 * bridge/client — the office, watching your own Claude Code session.
 *
 * Deliberately small. This is not the product page; it is the one thing the bridge
 * exists to show, on the bridge's own origin so there is no CORS and no mixed content.
 *
 * The token is read from the URL fragment (`#token=…`) rather than the query string,
 * because a fragment is never sent to a server or written to server logs. The bridge
 * prints the full URL when it starts.
 *
 * The panel beside the floor is the same component `/office` uses. It used to be a second
 * implementation that had already fallen behind — no dossier, no artifacts list — which is
 * backwards, because a live session is exactly where artifacts appear. Sharing it is what
 * stops the live view from being the poor relation of the recorded one.
 */

import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Selection } from '../../../lib/office-view/react/OfficeView.tsx';
import { Inspector } from '../../../lib/office-view/react/Inspector.tsx';
import { useDismissed } from '../../../lib/office-view/react/useDismissed.ts';
import { OfficeStage } from '../../../lib/office-view/three/OfficeStage.tsx';
import { isOfficeEvent } from '../../../lib/office-view/core/events.ts';
import type { OfficeEvent } from '../../../lib/office-view/core/types.ts';
import { codingSessionPlan } from '../../../lib/floorplans/coding-session.ts';
import '../../../lib/office-view/office-view.css';
import './bridge.css';

/** The bridge prints a URL containing this; without it the stream is refused. */
function readToken(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  return fragment.get('token') ?? new URLSearchParams(window.location.search).get('token') ?? '';
}

type Status = 'connecting' | 'live' | 'error';

function App() {
  const token = useMemo(() => readToken(), []);
  const [events, setEvents] = useState<OfficeEvent[]>([]);
  /** State of the socket only. Whether we have a token is a separate question. */
  const [connection, setConnection] = useState<Status>('connecting');
  const [selection, setSelection] = useState<Selection>(null);
  /** Chrome off, floor only — for putting a running session on a second screen. */
  const [presenting, setPresenting] = useState(false);
  /** Show only agents with something running. Most useful here, where a live burst is. */
  const [activeOnly, setActiveOnly] = useState(false);
  const { dismissed, dismiss, dismissAll, restoreAll } = useDismissed('bridge:live');
  /** Batch incoming events into one render per frame rather than one per event. */
  const pending = useRef<OfficeEvent[]>([]);
  const flushing = useRef(false);

  useEffect(() => {
    if (!token) return;
    const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);

    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection('error');
    source.onmessage = (message) => {
      let event: unknown;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      // The bridge validates on the way in; this validates on the way out. The office
      // must never animate something that is not a well-formed event.
      if (!isOfficeEvent(event)) return;

      pending.current.push(event);
      if (flushing.current) return;
      flushing.current = true;
      requestAnimationFrame(() => {
        flushing.current = false;
        const batch = pending.current;
        pending.current = [];
        setEvents((previous) => [...previous, ...batch]);
      });
    };

    return () => source.close();
  }, [token]);

  /*
   * Two keys, and only two. The recorded view has scrub, speed and a renderer toggle
   * because a recording can be moved through; a live office has exactly one moment — now —
   * so the only things worth a shortcut are getting the chrome out of the way, and getting
   * back out of whatever you clicked.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'p' || event.key === 'P') setPresenting((on) => !on);
      // Innermost first: leave presentation before clearing a selection.
      if (event.key === 'Escape') {
        if (presenting) setPresenting(false);
        else setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting]);

  /** No token is not a socket failure, but it is still a disconnected office. */
  const status: Status = token ? connection : 'error';

  const usage = useMemo(() => {
    let input = 0;
    let output = 0;
    let unavailable = false;
    for (const event of events) {
      if (event.type !== 'usage.reported') continue;
      if (event.usage.source === 'unavailable') unavailable = true;
      input += event.usage.inputTokens ?? 0;
      output += event.usage.outputTokens ?? 0;
    }
    return { input, output, unavailable };
  }, [events]);

  const floor = (
    <OfficeStage
      plan={codingSessionPlan}
      events={events}
      modeLabel="Live · your Claude Code session"
      playing
      follow
      selection={selection}
      onSelect={setSelection}
      dismissed={dismissed}
      activeOnly={activeOnly}
    />
  );

  if (presenting) {
    // Everything except the floor. The mode label stays — it lives inside the renderer,
    // and a presentation is when a viewer is most likely to take it at face value.
    return (
      <main className="bridge is-presenting">
        <div className="bridge-floor">{floor}</div>
        <p className="bridge-presenting-hint">Live · press P or Esc to come back</p>
      </main>
    );
  }

  return (
    <main className="bridge">
      <header className="bridge-top">
        <span className="bridge-brand">
          <b>O6</b> office
        </span>
        <span className={`bridge-status is-${status}`}>
          {status === 'live' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
        <span className="bridge-usage">
          {/* Tokens come from the session transcript, and the panel says so. If the
              transcript cannot be read we say "unavailable", never a confident zero. */}
          {usage.unavailable
            ? 'Tokens unavailable'
            : `${(usage.input + usage.output).toLocaleString()} tokens · from transcript`}
        </span>
      </header>

      {!token ? (
        <p className="bridge-hint">
          No token in the URL. Open the link the bridge printed when it started.
        </p>
      ) : null}

      <div className="bridge-body">
        <div className="bridge-floor">{floor}</div>

        {/* The same panel /office uses, so the live view cannot fall behind it again. */}
        <Inspector
          plan={codingSessionPlan}
          events={events}
          selection={selection}
          onSelect={setSelection}
          showClock
          emptyHint="Nothing here yet. Operations appear as your session performs them."
          dismissed={dismissed}
          onDismiss={dismiss}
          onDismissAll={dismissAll}
          onRestore={restoreAll}
          activeOnly={activeOnly}
          onActiveOnly={setActiveOnly}
        />
      </div>

      <footer className="bridge-foot">
        <span>{events.length} events</span>
        <span className="bridge-detail">
          Click a desk, a person, or a folder · <kbd>P</kbd> presents
        </span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * bridge/client — the office, watching your own Claude Code session.
 *
 * Deliberately small. This is not the product page; it is the one thing the bridge
 * exists to show, on the bridge's own origin so there is no CORS and no mixed content.
 *
 * The token is read from the URL fragment (`#token=…`) rather than the query string,
 * because a fragment is never sent to a server or written to server logs. The bridge
 * prints the full URL when it starts.
 */

import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Selection } from '../../../lib/office-view/react/OfficeView.tsx';
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


  /** No token is not a socket failure, but it is still a disconnected office. */
  const status: Status = token ? connection : 'error';

  /**
   * The most recent thing that happened at whatever was clicked.
   *
   * Derived rather than stored: the panel must never be able to disagree with the stream
   * it is describing, and the only reliable way to guarantee that is to compute it from
   * the stream every time.
   */
  /** The desks each department owns, so a department can be matched to its own events. */
  const roomStations = useMemo(() => {
    const byRoom = new Map<string, Set<string>>();
    for (const station of codingSessionPlan.stations) {
      if (!station.room) continue;
      const set = byRoom.get(station.room) ?? new Set<string>();
      set.add(station.id);
      byRoom.set(station.room, set);
    }
    return byRoom;
  }, []);

  const detail = useMemo(() => {
    if (!selection) return null;
    const matches = (event: OfficeEvent) => {
      switch (selection.kind) {
        case 'station':
          return 'station' in event && event.station === selection.id;
        case 'worker':
          return 'worker' in event && event.worker === selection.id;
        case 'work':
          return 'work' in event && event.work?.id === selection.id;
        case 'department': {
          // A department is the union of its desks. Nothing is aggregated or rephrased —
          // the panel still shows one desk's own words.
          const desks = roomStations.get(selection.id);
          if (!desks) return false;
          return 'station' in event && typeof event.station === 'string' && desks.has(event.station);
        }
        default: {
          // A new selection kind must be handled here rather than silently falling
          // through to the wrong filter.
          const never: never = selection;
          return Boolean(never);
        }
      }
    };
    const match = [...events].reverse().find(matches);
    return match ? `${match.label}${match.detail ? ` — ${match.detail}` : ''}` : 'Nothing yet.';
  }, [selection, events, roomStations]);

  /**
   * Every operation, newest first — and narrowed to whatever is selected.
   *
   * The floor is the lossy view by design: it shows what is happening now, not everything
   * that has happened. This is the other half, so a session can actually be read back.
   * Labels are the producer's own words, never re-phrased here.
   */
  const operations = useMemo(() => {
    const desks = selection?.kind === 'department' ? roomStations.get(selection.id) : null;
    const wanted = (event: OfficeEvent) => {
      if (!selection) return true;
      switch (selection.kind) {
        case 'station':
          return 'station' in event && event.station === selection.id;
        case 'worker':
          return 'worker' in event && event.worker === selection.id;
        case 'work':
          return 'work' in event && event.work?.id === selection.id;
        case 'department':
          return Boolean(desks) && 'station' in event && typeof event.station === 'string'
            ? desks!.has(event.station as string)
            : false;
        default:
          return true;
      }
    };
    // Usage reports are a running meter rather than an operation; they have their own
    // readout in the header and would otherwise drown the log.
    return events
      .filter((event) => event.type !== 'usage.reported' && wanted(event))
      .slice(-400)
      .reverse();
  }, [events, selection, roomStations]);

  /** What the panel is currently scoped to, in the plan's own words. */
  const scope = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'department') {
      const room = codingSessionPlan.rooms.find((candidate) => candidate.id === selection.id);
      const desks = roomStations.get(selection.id);
      return room
        ? `${room.label} · ${desks?.size ?? 0} ${desks?.size === 1 ? 'desk' : 'desks'}`
        : null;
    }
    if (selection.kind === 'station') {
      const station = codingSessionPlan.stations.find((candidate) => candidate.id === selection.id);
      return station ? `${station.role} desk` : selection.id;
    }
    if (selection.kind === 'worker') return selection.id === 'main' ? 'The agent' : selection.id;
    return 'One unit of work';
  }, [selection, roomStations]);

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
        <div className="bridge-floor">
          <OfficeStage
            plan={codingSessionPlan}
            events={events}
            modeLabel="Live · your Claude Code session"
            playing
            follow
            selection={selection}
            onSelect={setSelection}
          />
        </div>

        <aside className="bridge-log" aria-label="Operations">
          <div className="bridge-log-head">
            <strong>{scope ?? 'All operations'}</strong>
            {selection ? (
              <button type="button" onClick={() => setSelection(null)}>
                Show everything
              </button>
            ) : null}
          </div>
          <p className="bridge-log-count">
            {operations.length === 400 ? 'last 400 of ' : ''}
            {operations.length} {operations.length === 1 ? 'operation' : 'operations'}
            {selection ? ' here' : ' this session'}
          </p>

          {operations.length === 0 ? (
            <p className="bridge-log-empty">
              Nothing here yet. Operations appear as your session performs them.
            </p>
          ) : (
            <ol className="bridge-log-list">
              {operations.map((event) => (
                <li key={event.id} className={`is-${event.type.split('.')[1] ?? event.type}`}>
                  <span className="bridge-op-meta">
                    {'station' in event && event.station ? String(event.station) : '—'}
                    {' · '}
                    {new Date(event.occurredAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  {/* The producer's own words. Never re-phrased, never summarised. */}
                  <span className="bridge-op-label">{event.label}</span>
                  {event.detail ? <span className="bridge-op-detail">{event.detail}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      <footer className="bridge-foot">
        <span>{events.length} events</span>
        <span className="bridge-detail">{detail ?? 'Click a desk, a person, or a folder.'}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

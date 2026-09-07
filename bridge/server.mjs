/**
 * bridge/server — receives your Claude Code session and streams it to the office.
 *
 * The whole point of it being local: your session's activity never leaves the machine.
 * Hooks POST here, this maps them onto the event contract, and the office reads them
 * over SSE from the same origin — which is also why the bridge serves the office page
 * itself rather than leaving a deployed HTTPS site to reach into http://localhost.
 *
 * Security posture, small server or not: loopback only, a required token, every payload
 * validated before it is trusted, and a bounded ring buffer so a long session cannot
 * grow memory without limit.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, requireToken } from './config.mjs';
import { mapHook } from './map-claude-code.mjs';
import { TranscriptWatcher } from './transcript.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(HERE, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Bodies are small; anything larger is not a hook payload and is refused. */
const MAX_BODY_BYTES = 512 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Timing-safe enough for a local token, and constant-time on length mismatch. */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function createBridge(options = {}) {
  const config = { ...loadConfig(), ...options };
  const token = requireToken(config);

  /** Monotonic sequence, so replay orders identically to live. */
  let seq = 0;
  const runId = `session-${Date.now()}`;
  /** Bounded ring buffer of everything emitted this run. */
  const events = [];
  /** Open SSE responses. */
  const clients = new Set();
  /** Per-turn state the mapping needs (which folder the current work is). */
  const state = { currentPromptId: null, workLabels: {} };
  /** One transcript watcher per session id we have been told about. */
  const watchers = new Map();
  /** The only floor this bridge renders, used to complete a producer's run.started. */
  const BRIDGE_PLAN = 'coding-session';
  const log = options.log ?? ((message) => process.stderr.write(`[o6-bridge] ${message}\n`));

  /**
   * How many events left here structurally malformed. Surfaced on /health rather than
   * swallowed: the bridge producing an event the office cannot read is a bug in the
   * bridge, and a silent count of zero would hide it.
   */
  let malformed = 0;

  function emit(input) {
    seq += 1;
    /*
     * A mapping that sets a key to `undefined` — `id` when a hook arrived without a
     * tool_use_id, say — still owns that key, so spreading it last CLOBBERS the envelope
     * value with undefined. The event then fails validation and the client drops it
     * without a word. Strip absent keys first so the envelope's own defaults survive.
     */
    const supplied = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) supplied[key] = value;
    }

    const event = {
      v: 1,
      id: supplied.id ?? `${runId}-${seq}`,
      seq,
      runId,
      source: 'claude-code',
      occurredAt: supplied.occurredAt ?? Date.now(),
      receivedAt: Date.now(),
      ...supplied,
    };

    // Cheap structural check. Not the full contract validator — that lives in a .ts the
    // bridge cannot import — but enough to notice the envelope going wrong again.
    if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') {
      malformed += 1;
      log(`malformed event (id=${JSON.stringify(event.id)}, type=${JSON.stringify(event.type)})`);
    }
    events.push(event);
    // Drop the oldest rather than refusing new ones: a long session should keep working,
    // and the office is a live view, not the system of record.
    if (events.length > config.maxEvents) events.splice(0, events.length - config.maxEvents);

    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
    return event;
  }

  /** Start following a session's transcripts so usage can be reported honestly. */
  function watchTranscript(transcriptPath) {
    if (!transcriptPath || watchers.has(transcriptPath)) return;
    if (!existsSync(transcriptPath)) {
      log(`transcript not found, usage will be unavailable: ${transcriptPath}`);
      // Say so on the floor rather than showing a confident zero.
      emit({
        type: 'usage.reported',
        label: 'Token usage unavailable',
        detail: 'The session transcript could not be read.',
        usage: { source: 'unavailable' },
      });
      return;
    }
    const watcher = new TranscriptWatcher(
      transcriptPath,
      (usage) => {
        emit({
          type: 'usage.reported',
          /*
           * A catch-up total covers work that happened before the office was watching.
           * Arrival is not occurrence: it is labelled as a total so it cannot be read as
           * a burst of activity that just took place.
           */
          label: usage.catchUp
            ? usage.worker
              ? 'Subagent usage so far'
              : 'Session usage so far'
            : usage.worker
              ? 'Subagent usage'
              : 'Session usage',
          detail: usage.catchUp
            ? `Total of ${usage.messages} messages already in the transcript when the office connected`
            : (usage.assignment ?? undefined),
          usage: {
            source: 'transcript',
            worker: usage.worker ?? undefined,
            model: usage.model,
            inputTokens: usage.inputTokens + usage.cacheCreationTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
          },
        });
      },
      { pollMs: config.pollMs, onWarn: log },
    );
    watcher.start();
    watchers.set(transcriptPath, watcher);
    log(`following transcript: ${transcriptPath}`);
  }

  /** Handle one hook payload. Returns how many events it produced. */
  function ingest(payload) {
    const result = mapHook(payload, state);
    if (result.ignored === 'unknown hook') {
      // Never silently swallowed: a new Claude Code event should look like a gap to fill.
      log(`ignoring unrecognised hook: ${payload?.hook_event_name}`);
    }
    if (result.setWork) {
      state.currentPromptId = result.setWork.id;
      state.workLabels[result.setWork.id] = result.setWork.label;
    }
    if (payload?.transcript_path) watchTranscript(payload.transcript_path);

    for (const event of result.events) emit(event);
    return result.events.length;
  }

  function serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // Contain the path: a bridge serving arbitrary files off the developer's disk would
    // be a genuine problem, small server or not.
    const target = normalize(join(STATIC_DIR, relative));
    if (!target.startsWith(STATIC_DIR)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      // Fall back to the app shell only for route-shaped paths. A request for a named
      // file that does not exist should 404 rather than quietly return HTML — otherwise
      // a probe for `/package.json` gets a 200 and looks like it found something.
      const looksLikeARoute = !extname(relative);
      const shell = join(STATIC_DIR, 'index.html');
      if (looksLikeARoute && existsSync(shell)) {
        response
          .writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
          .end(readFileSync(shell));
        return;
      }
      if (existsSync(shell)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      response
        .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(
          'The office UI has not been built yet.\n\nRun: npm run build:bridge\n\n' +
            'The hook endpoint and event stream work regardless.\n',
        );
      return;
    }
    /*
     * The HTML must never be cached. Its whole job is to name the current hashed bundle,
     * so a stale copy pins the browser to a client build that no longer exists on disk —
     * you rebuild, reload, and see the old UI with no error to explain it. The hashed
     * assets themselves are immutable by construction and can be cached hard.
     */
    const isHtml = extname(target) === '.html';
    response.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    response.end(readFileSync(target));
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${config.host}:${config.port}`);
    const pathname = url.pathname;

    // --- hook ingest -----------------------------------------------------------
    if (pathname === '/hook') {
      if (request.method !== 'POST') {
        response.writeHead(405).end('POST only');
        return;
      }
      const provided = request.headers['x-o6-token'] ?? url.searchParams.get('token');
      if (!tokenMatches(provided, token)) {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"bad token"}');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        // Malformed input is rejected, not crashed on, and not guessed at.
        response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: `unreadable payload: ${error.message}` }));
        return;
      }
      const count = ingest(payload);
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: true, events: count }));
      return;
    }

    /*
     * --- direct event ingest ---------------------------------------------------
     *
     * The office consumes one contract, and /hook is only a translator from Claude Code's
     * hook shape into it. Any other agent runtime can skip the translation and post the
     * contract itself, which is what makes "connect your work" a claim about agents in
     * general rather than about one product.
     *
     * Accepts one event or an array. The envelope fields the bridge owns (v, seq, runId,
     * source, receivedAt) are filled in here, so a producer supplies only what it knows:
     * type, label, and whichever of station / worker / work apply.
     */
    if (pathname === '/event') {
      if (request.method !== 'POST') {
        response.writeHead(405).end('POST only');
        return;
      }
      const provided = request.headers['x-o6-token'] ?? url.searchParams.get('token');
      if (!tokenMatches(provided, token)) {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"bad token"}');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: `unreadable payload: ${error.message}` }));
        return;
      }

      const incoming = Array.isArray(payload) ? payload : [payload];
      const rejected = [];
      let accepted = 0;
      for (const [index, candidate] of incoming.entries()) {
        // Say what was wrong rather than dropping it quietly: a producer being written
        // against this endpoint needs to know why its event did not appear.
        if (!candidate || typeof candidate !== 'object') {
          rejected.push({ index, why: 'not an object' });
          continue;
        }
        if (typeof candidate.type !== 'string' || !candidate.type) {
          rejected.push({ index, why: 'missing "type"' });
          continue;
        }
        if (typeof candidate.label !== 'string' || !candidate.label) {
          rejected.push({ index, why: 'missing "label" — every event must say what happened' });
          continue;
        }
        emit({
          ...candidate,
          source: candidate.source ?? 'claude-code',
          /*
           * `plan` says which floor to render on, and this bridge only ever renders one.
           * Filling it in is not inventing anything about the work — it is the bridge
           * supplying a fact it already knows, so a producer does not have to learn the
           * name of our floor plan just to say "I started".
           */
          ...(candidate.type === 'run.started' && !candidate.plan ? { plan: BRIDGE_PLAN } : {}),
        });
        accepted += 1;
      }

      response.writeHead(rejected.length && !accepted ? 400 : 200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({ ok: accepted > 0, events: accepted, rejected }));
      return;
    }

    // --- event stream ----------------------------------------------------------
    if (pathname === '/events') {
      const provided = request.headers['x-o6-token'] ?? url.searchParams.get('token');
      if (!tokenMatches(provided, token)) {
        response.writeHead(401).end('bad token');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Replay what has happened so far, so a browser opened mid-session is not blank.
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      clients.add(response);
      const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
      keepAlive.unref?.();
      request.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(response);
      });
      return;
    }

    // --- health ----------------------------------------------------------------
    if (pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          runId,
          events: events.length,
          clients: clients.size,
          watching: [...watchers.keys()].length,
          malformed,
        }),
      );
      return;
    }

    serveStatic(request, response, pathname);
  });

  return {
    server,
    config,
    token,
    get events() {
      return events;
    },
    ingest,
    emit,
    listen: () =>
      new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server))),
    close: () => {
      for (const watcher of watchers.values()) watcher.stop();
      for (const client of clients) client.end();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

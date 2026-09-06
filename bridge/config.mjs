/**
 * bridge/config — every knob the bridge has, in one place.
 *
 * Nothing here is a magic number buried in logic. The bridge is a small server that
 * listens for your coding session's activity, so its security posture matters more than
 * its size suggests: it binds to loopback only, and it refuses to start without a token
 * rather than defaulting to open.
 */

import { randomBytes } from 'node:crypto';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  const token = env.O6_BRIDGE_TOKEN?.trim();

  return {
    /** Loopback only, always. Session activity must not leave the machine. */
    host: '127.0.0.1',
    port: int(env.O6_BRIDGE_PORT, 4141),
    token,
    /** How often to re-read the transcript for usage. */
    pollMs: int(env.O6_TRANSCRIPT_POLL_MS, 1000),
    /** Ring buffer cap, so a long session cannot grow memory without bound. */
    maxEvents: int(env.O6_MAX_EVENTS, 5000),
  };
}

/**
 * Fail loudly on a missing or placeholder token.
 *
 * Deliberately not "generate one silently and carry on": the token has to end up in the
 * hook command too, so a bridge that invented its own would look like it was working
 * while silently rejecting every hook.
 */
export function requireToken(config) {
  const placeholders = new Set(['', 'changeme', 'token', 'secret', 'your-token-here']);
  if (!config.token || placeholders.has(config.token.toLowerCase())) {
    throw new Error(
      'O6_BRIDGE_TOKEN is not set (or is a placeholder).\n\n' +
        'The bridge will not start without one — it receives your session activity, and\n' +
        'an unauthenticated local port is reachable by anything else running on this\n' +
        'machine.\n\n' +
        `Generate one:  O6_BRIDGE_TOKEN=${suggestToken()}\n` +
        'Or run `npm run bridge` which generates one and prints the matching hook block.',
    );
  }
  if (config.token.length < 16) {
    throw new Error('O6_BRIDGE_TOKEN is too short; use at least 16 characters.');
  }
  return config.token;
}

export function suggestToken() {
  return randomBytes(24).toString('base64url');
}

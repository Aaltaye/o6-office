/**
 * bridge/office-config — one place that says what this office is.
 *
 * Configuration used to be spread across environment variables the bridge read, constants
 * in the scheduler, and literals in page components, so forking this to watch your own
 * agents meant editing source to change a port or a name.
 *
 * Layering follows the pattern this codebase's sibling library settles on, highest wins:
 *
 *   environment variables  >  office.config.local.json  >  office.config.json  >  defaults
 *
 * Deliberately dependency-free and hand-rolled rather than pulling in a schema library:
 * the bridge is plain Node with zero dependencies on purpose, so that `npx` on this repo
 * stays a small download and the hook path cannot break because of somebody else's package.
 * The trade-off is that validation here is shallow — it checks shapes it actually relies
 * on and leaves the rest alone, rather than pretending to a completeness it does not have.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The shape everything falls back to. Also the documentation of what exists. */
export const DEFAULTS = {
  name: 'O6 Office',
  tagline: 'Make invisible work visible.',
  bridge: { port: 4141, plan: 'coding-session', transcriptPollMs: 1000, maxEvents: 5000 },
  office: { maxGapMs: 1400, maxRate: 3, aggregateAbove: 4 },
  model: { anthropic: 'claude-haiku-4-5', openai: 'gpt-4.1-mini' },
};

/**
 * Environment overrides, by the path they set. Explicit rather than derived from key
 * names: a prefix-and-camelCase convention is clever until someone's unrelated `O6_NAME`
 * silently renames their office.
 */
const ENV_MAP = {
  O6_BRIDGE_PORT: ['bridge', 'port', 'positive'],
  O6_TRANSCRIPT_POLL_MS: ['bridge', 'transcriptPollMs', 'positive'],
  O6_MAX_EVENTS: ['bridge', 'maxEvents', 'positive'],
  O6_OFFICE_NAME: ['name', null, 'text'],
  O6_MAX_GAP_MS: ['office', 'maxGapMs', 'positive'],
};

/**
 * Every numeric knob here is a count, an interval or a port, and none of them mean
 * anything at zero or below. A negative cap is not a preference, it is a typo, and
 * honouring it would produce an office that silently keeps no events.
 */
const POSITIVE_KNOBS = [
  ['bridge', 'port'],
  ['bridge', 'transcriptPollMs'],
  ['bridge', 'maxEvents'],
  ['office', 'maxGapMs'],
  ['office', 'maxRate'],
  ['office', 'aggregateAbove'],
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep merge, with later sources winning. Arrays replace rather than concatenate. */
function merge(base, next) {
  if (!isObject(next)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(next)) {
    // Comments live in the file itself, so they are readable where they apply.
    if (key === '$comment') continue;
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

/** A JSON file, or nothing. A missing file is not an error — that is what makes the
 *  `.local.` override usable without every checkout needing one. */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Loud, because a config file that is present but broken is a mistake worth stopping
    // for — unlike one that is simply absent.
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

export function loadOfficeConfig({ root, env = process.env } = {}) {
  const base = root ?? fileURLToPath(new URL('..', import.meta.url));
  const at = (name) => `${base}/${name}`.replace(/\\/g, '/');

  let config = merge(DEFAULTS, readJson(at('office.config.json')) ?? {});
  config = merge(config, readJson(at('office.config.local.json')) ?? {});

  for (const [key, [section, leaf, kind]] of Object.entries(ENV_MAP)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    if (kind === 'text') {
      config = { ...config, [section]: String(raw) };
      continue;
    }
    const value = Number(raw);
    // Nonsense is ignored rather than honoured, and the default stands.
    if (!Number.isFinite(value) || value <= 0) continue;
    config = { ...config, [section]: { ...config[section], [leaf]: value } };
  }

  // A file can carry nonsense too — the same rule applies wherever the value came from.
  for (const [section, leaf] of POSITIVE_KNOBS) {
    const value = config[section]?.[leaf];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) continue;
    config = { ...config, [section]: { ...config[section], [leaf]: DEFAULTS[section][leaf] } };
  }

  return config;
}

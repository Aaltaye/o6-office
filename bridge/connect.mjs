/**
 * bridge/connect — wire a Claude Code project up to the office without hand-editing JSON.
 *
 * Merging a hook block into `.claude/settings.json` by hand is the step where people give
 * up: it is fiddly, it is easy to clobber settings you already had, and if you get it
 * subtly wrong nothing happens and nothing tells you why. This does it for you, and is
 * deliberately conservative about somebody else's configuration file:
 *
 *  - it never drops a key it did not put there, including hooks for other tools;
 *  - it is idempotent, so running it twice does not stack up duplicate curls;
 *  - it backs the file up before writing;
 *  - it reports exactly what it changed, so you can check rather than trust.
 *
 * The merge itself is a pure function so it can be tested without touching a real machine.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * How we recognise a hook entry as ours, so we can replace it rather than duplicate it.
 *
 * Anchored on the endpoint URL followed by a non-path character. It used to be the four
 * characters `/hook`, which is also inside `/hooks/` — the conventional directory a project
 * keeps its own hook scripts in. So an ordinary `bash .claude/hooks/format.sh` was read as
 * ours and DELETED on merge: silently destroying somebody's configuration in order to
 * install a visualisation, which is the worst thing a tool that edits your settings can do.
 * Caught by running the wizard against a project that had one.
 */
const O6_ENDPOINT = /(https?:\/\/[^\s"\\]+?)\/hook(?![\w/-])/;

/** Is this hook entry one of ours? */
export function isOurHook(entry) {
  return O6_ENDPOINT.test(JSON.stringify(entry ?? ''));
}

/** Where an existing hook entry sends events, or null if it is not ours. */
export function hookWiring(entry) {
  const text = JSON.stringify(entry ?? '');
  const url = O6_ENDPOINT.exec(text);
  if (!url) return null;
  const token = /x-o6-token:\s*([^\s"\\]+)/.exec(text);
  return { url: url[1], token: token?.[1] ?? null };
}

/**
 * Merge our hook block into an existing settings object.
 *
 * @param {object} settings the parsed contents of .claude/settings.json (or {})
 * @param {object} hooks our hook block, keyed by hook event name
 * @returns {{settings: object, added: string[], replaced: string[], kept: string[]}}
 */
export function mergeHooks(settings, hooks) {
  const next = { ...settings, hooks: { ...settings.hooks } };
  const added = [];
  const replaced = [];
  const kept = [];

  for (const [event, matchers] of Object.entries(hooks)) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    // Anything that is not ours stays exactly as it was. Someone else's hooks are not
    // ours to reorganise, and silently dropping them would be the worst possible bug for
    // a tool that edits your config.
    const theirs = existing.filter((entry) => !isOurHook(entry));
    const hadOurs = theirs.length !== existing.length;

    next.hooks[event] = [...theirs, ...matchers];
    if (hadOurs) replaced.push(event);
    else added.push(event);
    if (theirs.length > 0) kept.push(`${event} (${theirs.length} other)`);
  }

  return { settings: next, added, replaced, kept };
}

/** Where a project's Claude Code settings live, relative to a project root. */
export function settingsPathFor(projectRoot) {
  return join(projectRoot, '.claude', 'settings.json');
}

/**
 * Read, merge and write. Returns a report rather than printing, so the CLI owns the voice
 * and the tests can assert on facts.
 *
 * @param {{projectRoot: string, hooks: object, dryRun?: boolean}} options
 */
export function connectProject({ projectRoot, hooks, dryRun = false }) {
  const path = settingsPathFor(projectRoot);
  const existed = existsSync(path);

  let current = {};
  if (existed) {
    const raw = readFileSync(path, 'utf8');
    try {
      current = JSON.parse(raw);
    } catch (error) {
      // Refuse rather than overwrite: a settings file we cannot parse is one we could
      // destroy, and the person can fix or move it in five seconds.
      throw new Error(
        `${path} is not valid JSON (${error.message}). Fix or move it, then run this again.`,
      );
    }
  }

  const { settings, added, replaced, kept } = mergeHooks(current, hooks);
  let backup = null;

  if (!dryRun) {
    if (existed) {
      backup = `${path}.before-o6-office`;
      copyFileSync(path, backup);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return { path, existed, backup, added, replaced, kept, settings };
}

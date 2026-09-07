/**
 * bridge/wizard — getting somebody from "clone" to "I can see my agent working".
 *
 * The pieces to connect this have existed for a while: `o6-office connect` merges the hooks
 * and `o6-office` starts the bridge. What did not exist is the thing that actually stops
 * people: knowing that there ARE two commands, that they go in that order, in two
 * terminals — and then having no way to tell whether it worked. Claude Code fires hooks
 * only when it next does something, so a botched setup and a correct one look identical
 * until you have run a session and stared at an empty office wondering which it was.
 *
 * So the wizard's real job is not the merging. It is the last step: send an event down the
 * exact path a real hook takes and watch it come out of the stream the office reads. That
 * is the difference between "we wrote some JSON" and "this works".
 *
 * The survey and the verification live here, apart from the prompting, because they are
 * the parts worth testing and a readline conversation is not.
 *
 * Zero dependencies, like the rest of bridge/ — this runs from `npx` on a stranger's
 * machine, and every package added here is a way for that to fail for reasons that have
 * nothing to do with us.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { O6_MARKER, settingsPathFor } from './connect.mjs';

/**
 * What we found, before changing anything.
 *
 * Deliberately just facts. Everything the wizard decides is derived from this, so the
 * decisions can be tested without a filesystem, a terminal or a port.
 */
export function surveyProject({ root, port }) {
  const settingsPath = settingsPathFor(root);
  const claudeDir = join(root, '.claude');

  let settings = null;
  let unreadable = false;
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      // A settings file that exists but does not parse is the one case where we must not
      // touch anything: rewriting it would destroy configuration we cannot even read.
      unreadable = true;
    }
  }

  const hooks = settings?.hooks ?? {};
  const events = Object.keys(hooks);
  const ours = events.filter((event) =>
    JSON.stringify(hooks[event] ?? '').includes(O6_MARKER),
  );

  return {
    root,
    port,
    settingsPath,
    /** Does this look like a Claude Code project at all? */
    hasClaudeDir: existsSync(claudeDir),
    hasSettings: settings !== null,
    settingsUnreadable: unreadable,
    /** Hooks already wired to this office. */
    connectedEvents: ours,
    /** Hooks belonging to something else, which must survive untouched. */
    foreignEvents: events.filter((event) => !ours.includes(event)),
    /** Is the office page built? Without it the bridge serves nothing to look at. */
    officeBuilt: existsSync(new URL('./public/index.html', import.meta.url)),
  };
}

/**
 * What the wizard is going to do, in order, given what it found.
 *
 * Separated from doing it so the plan can be shown before anything happens and asserted in
 * a test. A step that is already done says so rather than being hidden, because "nothing to
 * do here" is information — it is how somebody re-running this learns they were already set
 * up rather than wondering whether it took.
 */
export function planSteps(survey) {
  const steps = [];

  if (survey.settingsUnreadable) {
    steps.push({
      id: 'blocked',
      needed: false,
      blocked: true,
      title: 'Read .claude/settings.json',
      detail:
        `${survey.settingsPath} exists but is not valid JSON. Nothing will be written — ` +
        'fix or move it first, because rewriting a file we cannot read would destroy ' +
        'configuration that is not ours.',
    });
    return steps;
  }

  steps.push({
    id: 'build',
    needed: !survey.officeBuilt,
    title: 'Build the office page',
    detail: survey.officeBuilt
      ? 'Already built.'
      : 'The bridge serves the office from bridge/public, which is not in git. `npm run build:bridge`.',
  });

  steps.push({
    id: 'hooks',
    needed: survey.connectedEvents.length === 0,
    title: 'Wire the hooks into .claude/settings.json',
    detail: survey.connectedEvents.length
      ? `Already wired: ${survey.connectedEvents.join(', ')}.`
      : survey.foreignEvents.length
        ? `Will add ours and keep yours (${survey.foreignEvents.join(', ')}), with a backup.`
        : `Will write ${survey.settingsPath}, with a backup if it exists.`,
  });

  steps.push({
    id: 'verify',
    needed: true,
    title: 'Prove it works',
    detail:
      'Send one event down the same path a real hook takes and watch it arrive on the ' +
      'stream the office reads. This is the step that tells you the setup is right, ' +
      'rather than you finding out later from an empty office.',
  });

  return steps;
}

/**
 * Push one event through the running bridge and confirm it comes back out.
 *
 * The whole point is that it uses the REAL path — an HTTP POST to /hook, shaped like a
 * Claude Code hook payload, and a listener on /events, which is precisely what the office
 * subscribes to. A check that called an internal function instead would pass while the
 * thing people actually need was broken.
 *
 * Returns what it saw rather than throwing, because "it did not arrive" is a result the
 * wizard has to report honestly, not an exception to swallow.
 */
export async function verifyRoundTrip({ port, token, timeoutMs = 4000, fetchImpl = fetch }) {
  const base = `http://127.0.0.1:${port}`;
  const marker = `setup-check-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const stream = await fetchImpl(`${base}/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!stream.ok || !stream.body) {
      return { ok: false, reason: `the office stream refused the connection (${stream.status})` };
    }

    const posted = await fetchImpl(`${base}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-o6-token': token },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: marker,
        tool_input: { command: 'echo', description: 'o6-office setup check' },
      }),
    });
    if (!posted.ok) {
      return { ok: false, reason: `the bridge refused the test event (${posted.status})` };
    }

    // Read the stream until our own event comes back, or we run out of patience.
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(marker)) return { ok: true, marker };
      // A long-lived stream replays history first; do not read forever on a busy bridge.
      if (buffer.length > 2_000_000) break;
    }
    return { ok: false, reason: 'the event was accepted but never came back out of the stream' };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, reason: `nothing arrived within ${timeoutMs}ms` };
    }
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * The line another runtime pastes to report its own work.
 *
 * Codex, a shell script, a cron job, anything that can run a command. Kept here so the
 * wizard and the docs cannot drift apart about what that line is.
 */
export function foreignRuntimeLine({ port, token }) {
  return (
    `O6_BRIDGE_PORT=${port} O6_BRIDGE_TOKEN=${token} \\\n` +
    `  npx github:Aaltaye/o6-office emit assignment.started "Running the tests" --desk operations`
  );
}

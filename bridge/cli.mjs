#!/usr/bin/env node
/**
 * o6-office bridge — one command, then paste one block.
 *
 * Connecting a Claude Code session should take two minutes, not an afternoon, so this
 * does the tedious parts: generates a token if there isn't one, starts the server, and
 * prints both the hook configuration to paste and the URL to open.
 *
 * Nothing here reaches the network. The bridge binds to loopback, and the hook commands
 * post to loopback. Your session stays on your machine.
 *
 * Usage:
 *   npm run bridge                 start, printing the hook block and URL
 *   npm run bridge -- --hooks-only print just the hook block and exit
 *   npm run bridge -- --port 4200  a different port
 */

import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createBridge } from './server.mjs';
import { loadConfig, suggestToken } from './config.mjs';
import { connectProject } from './connect.mjs';
import { buildEvent, sendEvent, EMITTABLE, DESKS } from './emit.mjs';

const argv = process.argv.slice(2);
/** The first bare word is the subcommand; everything else keeps working as it did. */
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'bridge';
const positional = argv.filter((arg, index) => {
  if (index === 0 && arg === command && command !== 'bridge') return false;
  if (arg.startsWith('--')) return false;
  // Drop values belonging to a preceding --flag.
  return !(index > 0 && argv[index - 1].startsWith('--'));
});
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : fallback;
};

if (flag('help') || flag('h') || command === 'help') {
  process.stdout.write(
    'o6-office — watch your agent work\n\n' +
      'COMMANDS\n' +
      '  o6-office                    start the bridge and print how to connect\n' +
      '  o6-office connect            wire this project up to Claude Code for you\n' +
      '  o6-office emit <type> <label>  report one event from any other runtime\n\n' +
      'BRIDGE\n' +
      '  --port <n>       port to listen on (default 4141, or O6_BRIDGE_PORT)\n' +
      '  --token <s>      token to use (default O6_BRIDGE_TOKEN, else generated)\n' +
      '  --hooks-only     print the hook block and exit without starting\n' +
      '  --write-snippet  also write bridge/hooks/settings-snippet.json\n\n' +
      'CONNECT\n' +
      '  --path <dir>     project to wire up (default: the current directory)\n' +
      '  --dry-run        show what would change, write nothing\n\n' +
      'EMIT\n' +
      `  --desk <name>    one of: ${DESKS.join(', ')}\n` +
      '  --worker <id>    who did it, e.g. agent:planner\n' +
      '  --detail <text>  a second line, shown under the label\n' +
      `  types: ${EMITTABLE.join(', ')}\n\n` +
      'Binds to 127.0.0.1 only. Nothing is sent off this machine.\n',
  );
  process.exit(0);
}

const token = value('token', process.env.O6_BRIDGE_TOKEN?.trim() || suggestToken());
const port = Number(value('port', loadConfig().port));

/**
 * The hooks to paste into `.claude/settings.json`.
 *
 * Every one is a plain curl that posts the hook's own stdin payload straight through —
 * the bridge does the interpreting. Kept deliberately dumb so it is easy to read before
 * you paste it into your own settings, and so it cannot fail in an interesting way.
 *
 * `|| true` matters: a hook that exits non-zero can interfere with the session, and a
 * visualisation being down must never break the work it is visualising.
 */
function hookBlock(bridgeUrl, bridgeToken) {
  const command =
    `curl -s -m 2 -X POST ${bridgeUrl}/hook ` +
    `-H "Content-Type: application/json" -H "x-o6-token: ${bridgeToken}" ` +
    '--data-binary @- >/dev/null || true';

  const events = [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStart',
    'SubagentStop',
    'PermissionRequest',
    'Stop',
    'StopFailure',
  ];

  return {
    hooks: Object.fromEntries(
      events.map((event) => [event, [{ hooks: [{ type: 'command', command }] }]]),
    ),
  };
}

const url = `http://127.0.0.1:${port}`;
const snippet = hookBlock(url, token);

if (flag('write-snippet')) {
  // The committed reference takes its token from the environment. A real token must
  // never be written into the repo, not even a local one.
  const path = fileURLToPath(new URL('./hooks/settings-snippet.json', import.meta.url));
  const reference = hookBlock('http://127.0.0.1:4141', '$O6_BRIDGE_TOKEN');
  writeFileSync(path, `${JSON.stringify(reference, null, 2)}\n`);
  process.stdout.write(`Wrote ${path} (token is read from $O6_BRIDGE_TOKEN)\n`);
}

const officeBuilt = existsSync(fileURLToPath(new URL('./public/index.html', import.meta.url)));

/**
 * Write the ready-to-paste hooks next to the project rather than dumping ~90 lines of
 * JSON into the terminal. The file carries a real token, so it is gitignored.
 */
function writeReadyToPaste() {
  const path = fileURLToPath(new URL('../.o6-office-hooks.json', import.meta.url));
  writeFileSync(path, `${JSON.stringify(snippet, null, 2)}\n`);
  return path;
}

function printInstructions({ hooksPath }) {
  process.stdout.write(
    `\n  O6 Office — bridge\n\n` +
      `  1. In your project, run:  o6-office connect\n` +
      `     (or merge this file into .claude/settings.json yourself:)\n\n` +
      `     ${hooksPath}\n\n` +
      `  2. Open the office:\n\n     ${url}/#token=${token}\n\n` +
      `  3. Use Claude Code as normal. The office follows along.\n\n` +
      `  Not using Claude Code? Anything that runs a shell command can report:\n` +
      `     o6-office emit assignment.started "Reading the spec" --desk reading\n\n` +
      (officeBuilt
        ? ''
        : `  Note: the office page is not built yet — run \`npm run build:bridge\`.\n` +
          `  The hook endpoint and event stream work regardless.\n\n`) +
      `  Listening on 127.0.0.1:${port}. Nothing leaves this machine.\n` +
      `  That file contains your token; it is gitignored. Stop with Ctrl+C.\n\n`,
  );
}

if (flag('hooks-only')) {
  // Explicitly asked for the JSON itself, so print it rather than a path.
  process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
  process.exit(0);
}

if (command === 'connect') {
  /*
   * Hand-merging ~90 lines of JSON into settings.json is where people give up. This does
   * it, but conservatively: it never drops a key it did not add, it is idempotent, and it
   * leaves a backup — because quietly damaging somebody's editor config would be a far
   * worse bug than a visualisation not working.
   */
  const projectRoot = value('path', process.cwd());
  const dryRun = flag('dry-run');
  let report;
  try {
    report = connectProject({ projectRoot, hooks: snippet.hooks, dryRun });
  } catch (error) {
    process.stderr.write(`\n  ${error.message}\n\n`);
    process.exit(1);
  }

  const changed = [...report.added, ...report.replaced];
  process.stdout.write(
    `\n  O6 Office — ${dryRun ? 'connect (dry run)' : 'connected'}\n\n` +
      `  ${dryRun ? 'Would write' : 'Wrote'}: ${report.path}\n` +
      (report.backup ? `  Backed up:  ${report.backup}\n` : '') +
      `  Hooks:      ${changed.length} (${report.replaced.length} refreshed)\n` +
      (report.kept.length
        ? `  Untouched:  hooks you already had — ${report.kept.join(', ')}\n`
        : '') +
      `\n  Now run \`o6-office\` in another terminal and open the URL it prints.\n` +
      `  Your session never leaves this machine.\n\n`,
  );
  process.exit(0);
}

if (command === 'emit') {
  /*
   * The escape hatch for every runtime that is not Claude Code. If your agent can run a
   * shell command, it can drive the office — no HTTP client, no SDK, no envelope to get
   * right.
   */
  let event;
  try {
    event = buildEvent({
      type: positional[0],
      label: positional.slice(1).join(' ') || value('label', ''),
      desk: value('desk', undefined),
      worker: value('worker', undefined),
      detail: value('detail', undefined),
      work: value('work', undefined),
      reason: value('reason', undefined),
      role: value('role', undefined),
      outcome: value('outcome', undefined),
      artifact: value('artifact', undefined),
    });
  } catch (error) {
    process.stderr.write(`\n  ${error.message}\n\n`);
    process.exit(1);
  }

  const result = await sendEvent({ event, url, token });
  if (result.offline) {
    // Not an error worth failing a build over: the office being down must never break the
    // work it is watching.
    process.stdout.write(`  (no bridge on ${url} — nothing recorded)\n`);
    process.exit(0);
  }
  if (!result.ok) {
    process.stderr.write(`  Refused (${result.status}): ${JSON.stringify(result.body)}\n`);
    process.exit(1);
  }
  process.stdout.write(`  ${event.type}${event.station ? ` at ${event.station}` : ''}\n`);
  process.exit(0);
}

const bridge = createBridge({ token, port });
await bridge.listen();
printInstructions({ hooksPath: writeReadyToPaste() });

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

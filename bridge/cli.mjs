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

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : fallback;
};

if (flag('help') || flag('h')) {
  process.stdout.write(
    'o6-office bridge — stream a Claude Code session into the office\n\n' +
      '  --port <n>       port to listen on (default 4141, or O6_BRIDGE_PORT)\n' +
      '  --token <s>      token to use (default O6_BRIDGE_TOKEN, else generated)\n' +
      '  --hooks-only     print the hook block and exit without starting\n' +
      '  --write-snippet  also write bridge/hooks/settings-snippet.json\n' +
      '  --help\n\n' +
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
      `  1. Merge the hooks in this file into .claude/settings.json:\n\n` +
      `     ${hooksPath}\n\n` +
      `  2. Open the office:\n\n     ${url}/#token=${token}\n\n` +
      `  3. Use Claude Code as normal. The office follows along.\n\n` +
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

const bridge = createBridge({ token, port });
await bridge.listen();
printInstructions({ hooksPath: writeReadyToPaste() });

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

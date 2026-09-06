/**
 * bridge/map-claude-code — Claude Code hooks to OfficeEvent.
 *
 * This is where most of the product risk lives. Forty `Read` calls in three seconds is
 * not forty people carrying folders across an office, and the temptation at every turn is
 * to make the picture livelier than the session actually was. The rules here:
 *
 *  - **Only map what a hook actually tells us.** No inferred intent, no invented labels.
 *    A tool's own name and its file's basename are facts; "Claude is thinking about the
 *    architecture" is not.
 *  - **Unknown hooks are ignored, loudly.** Claude Code adds hook events over time. A
 *    future one must not crash the bridge, and it must not be silently swallowed either.
 *  - **Usage never comes from here.** No hook payload carries tokens (verified). Usage is
 *    read from the transcript by `transcript.mjs`, and says so.
 *
 * A note on simultaneity (invariant I5). Parallel tool calls each fire their own
 * `PreToolUse`, arriving a few milliseconds apart rather than at one instant. That is
 * fine and is not smoothed over here: the scheduler orders by `occurredAt` and preserves
 * the real gaps, so calls milliseconds apart animate together, while genuinely sequential
 * calls seconds apart do not. Rounding timestamps to force them into one group would be
 * inventing a simultaneity the session did not report.
 */

/**
 * Which desk a tool's work happens at.
 *
 * A config table rather than a switch buried in logic, so adding a tool is a one-line
 * change and the whole mapping can be read at a glance. Prefix entries match MCP tools,
 * whose names are namespaced (`mcp__server__tool`).
 */
export const TOOL_DESKS = {
  exact: {
    Read: 'reading',
    Grep: 'reading',
    Glob: 'reading',
    NotebookRead: 'reading',
    ListAgents: 'reading',
    ToolSearch: 'reading',
    ListMcpResourcesTool: 'reading',
    ReadMcpResourceTool: 'reading',
    ReadMcpResourceDirTool: 'reading',
    ListSkills: 'reading',
    SearchSkills: 'reading',
    ListPlugins: 'reading',
    SearchPlugins: 'reading',
    TaskOutput: 'reading',

    Edit: 'workshop',
    Write: 'workshop',
    NotebookEdit: 'workshop',
    MultiEdit: 'workshop',
    Artifact: 'workshop',
    DesignSync: 'workshop',

    Bash: 'operations',
    PowerShell: 'operations',
    BashOutput: 'operations',
    KillShell: 'operations',
    Monitor: 'operations',
    CronCreate: 'operations',
    CronDelete: 'operations',
    CronList: 'operations',
    ScheduleWakeup: 'operations',
    TaskStop: 'operations',
    EnterWorktree: 'operations',
    ExitWorktree: 'operations',
    PushNotification: 'operations',
    RemoteTrigger: 'operations',
    SendUserFile: 'operations',

    WebFetch: 'research',
    WebSearch: 'research',

    Task: 'frontdesk',
    Agent: 'frontdesk',
    TodoWrite: 'frontdesk',
    Skill: 'frontdesk',
    EnterPlanMode: 'frontdesk',
    ExitPlanMode: 'frontdesk',
    SendMessage: 'frontdesk',
    Workflow: 'frontdesk',
    SuggestSkills: 'frontdesk',
    SuggestPluginInstall: 'frontdesk',

    AskUserQuestion: 'approvals',
    ReportFindings: 'approvals',
  },
  /** Matched by prefix, longest first. */
  prefix: {
    mcp__Claude_Browser__: 'research',
    'mcp__claude-in-chrome__': 'research',
    mcp__: 'operations',
  },
  /** Anything unrecognised. The front desk is where unassigned work lands. */
  fallback: 'frontdesk',
};

/** Tools whose success produces something you can open. */
const ARTIFACT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Hooks we deliberately do not put on the floor, with the reason. */
const IGNORED = {
  PostToolBatch:
    'each call in the batch already fired its own PreToolUse/PostToolUse; mapping this too would double-count',
  PermissionDenied: 'auto-mode denials are covered by PostToolUseFailure when the call fails',
  MessageDisplay: 'assistant prose is not work the office can show honestly',
  InstructionsLoaded: 'configuration loading, not work',
  ConfigChange: 'configuration loading, not work',
  PreCompact: 'context management is not floor activity',
  PostCompact: 'context management is not floor activity',
  Setup: 'startup, covered by SessionStart',
  TeammateIdle: 'agent-team lifecycle, not this session',
};

/*
 * Longest prefix first, so `mcp__foo__` beats `mcp__`. Sorted once at module load rather
 * than on every tool call — this runs for every hook of every session.
 */
const PREFIXES = Object.keys(TOOL_DESKS.prefix).sort((a, b) => b.length - a.length);

/**
 * Which desk a tool call belongs at.
 *
 * Deliberately total: this is fed by untrusted input (anything on the machine can POST to
 * the bridge) and by whatever tools a future Claude Code ships. It must return a desk for
 * every possible input and must never throw — a mapping that crashes takes the whole
 * office down mid-session, which is a far worse failure than routing something to the
 * fallback desk.
 *
 * `Object.hasOwn` rather than a bare index read, because a tool named `constructor`,
 * `toString` or `__proto__` would otherwise resolve against Object.prototype and hand
 * back a function where a desk id is expected.
 */
/**
 * Which desk a tool belongs at, AND whether that was a classification or a default.
 *
 * The distinction matters for the same reason "unavailable" is not "zero": the front desk
 * is where unrecognised work lands, so a tool shown there because nobody mapped it looks
 * exactly like delegation work that genuinely belongs there. Saying which it was lets the
 * office report "this desk was a default" instead of quietly implying it knew.
 */
export function routeForTool(toolName) {
  if (typeof toolName !== 'string' || !toolName) {
    return { desk: TOOL_DESKS.fallback, routing: 'fallback' };
  }
  if (Object.hasOwn(TOOL_DESKS.exact, toolName)) {
    return { desk: TOOL_DESKS.exact[toolName], routing: 'exact' };
  }
  for (const prefix of PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return { desk: TOOL_DESKS.prefix[prefix], routing: 'prefix' };
    }
  }
  return { desk: TOOL_DESKS.fallback, routing: 'fallback' };
}

export function deskForTool(toolName) {
  return routeForTool(toolName).desk;
}

/**
 * A short, factual description of a tool call — never a guess at intent.
 *
 * Coerces the name first for the same reason deskForTool does: this runs on untrusted
 * input, and a hook carrying a non-string `tool_name` used to throw here and take the
 * whole bridge process down mid-session.
 */
function describeTool(rawToolName, input) {
  const toolName = typeof rawToolName === 'string' ? rawToolName : '';
  const short = toolName?.startsWith('mcp__') ? toolName.split('__').slice(-1)[0] : toolName;
  if (!input || typeof input !== 'object') return short ?? 'Running a tool';

  // `description` is authored by the caller and is exactly the kind of literal label the
  // office wants, so it is preferred when present.
  if (typeof input.description === 'string' && input.description) return input.description;
  const file = input.file ?? input.file_path ?? input.path;
  if (typeof file === 'string' && file) return `${short} ${file.split(/[/\\]/).pop()}`;
  if (typeof input.command === 'string' && input.command) return `${short}: ${input.command}`;
  return short ?? 'Running a tool';
}

/** Trim a prompt to something that fits on a folder without misrepresenting it. */
function workLabel(prompt, fallback) {
  if (typeof prompt !== 'string' || !prompt.trim()) return fallback;
  const firstLine = prompt.trim().split('\n')[0];
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

/**
 * Map one hook payload to zero or more producer events.
 *
 * Returns `{ events, ignored }`. `ignored` is a reason string when the hook was
 * recognised but deliberately not put on the floor, and `'unknown hook'` when it is a
 * hook this mapping has never heard of — the caller logs that so a new Claude Code event
 * shows up as a gap to fill rather than disappearing.
 */
export function mapHook(payload, state = {}) {
  if (!payload || typeof payload !== 'object' || typeof payload.hook_event_name !== 'string') {
    return { events: [], ignored: 'not a hook payload' };
  }

  const hook = payload.hook_event_name;
  const agentId = payload.agent_id;
  // The unit of work is the turn: one prompt, tracked from the inbox to the outbox.
  const workId = payload.prompt_id ?? state.currentPromptId;
  const work = workId ? { id: workId, label: state.workLabels?.[workId] ?? 'This turn' } : undefined;
  const route = routeForTool(payload.tool_name);
  const desk = route.desk;

  const at = (extra) => ({ ...extra });

  switch (hook) {
    case 'SessionStart':
      return {
        events: [{ type: 'run.started', label: 'The session opens', plan: 'coding-session' }],
      };

    case 'SessionEnd':
      return {
        events: [
          {
            type: 'run.finished',
            label: 'The session ended',
            detail: payload.end_reason ? `Reason: ${payload.end_reason}` : undefined,
            outcome: 'completed',
          },
        ],
      };

    case 'UserPromptSubmit': {
      if (!payload.prompt_id) return { events: [], ignored: 'prompt without an id' };
      const label = workLabel(payload.prompt, 'A new instruction');
      return {
        events: [
          {
            type: 'work.received',
            label: `New instruction: ${label}`,
            work: { id: payload.prompt_id, label },
          },
        ],
        // The caller keeps this so later hooks in the turn can name the same folder.
        setWork: { id: payload.prompt_id, label },
      };
    }

    case 'PreToolUse':
      return {
        events: [
          at({
            type: 'assignment.started',
            label: describeTool(payload.tool_name, payload.tool_input),
            station: desk,
            worker: agentId ? `agent:${agentId}` : undefined,
            work,
            id: payload.tool_use_id,
            // routing is carried only when it was a fallback: there is nothing to say
            // about a tool that was actually recognised.
            payload:
              route.routing === 'fallback'
                ? { tool: payload.tool_name, routing: 'fallback' }
                : { tool: payload.tool_name },
          }),
        ],
      };

    case 'PostToolUse': {
      const events = [
        at({
          type: 'assignment.finished',
          label: describeTool(payload.tool_name, payload.tool_input),
          station: desk,
          worker: agentId ? `agent:${agentId}` : undefined,
          work,
        }),
      ];
      if (ARTIFACT_TOOLS.has(payload.tool_name)) {
        const file = payload.tool_input?.file ?? payload.tool_input?.file_path;
        const name = typeof file === 'string' ? file.split(/[/\\]/).pop() : 'a file';
        events.push(
          at({
            type: 'artifact.created',
            label: `Edited ${name}`,
            station: desk,
            work,
            artifact: { id: payload.tool_use_id ?? name, name, kind: 'file' },
          }),
        );
      }
      return { events };
    }

    case 'PostToolUseFailure':
      return {
        events: [
          at({
            type: 'assignment.failed',
            label: `${describeTool(payload.tool_name, payload.tool_input)} failed`,
            station: desk,
            worker: agentId ? `agent:${agentId}` : undefined,
            work,
            // The tool's own error text, verbatim. The office reports, it does not explain.
            reason: String(payload.tool_error ?? 'The tool call failed.').slice(0, 400),
          }),
        ],
      };

    case 'SubagentStart':
      if (!payload.agent_id) return { events: [], ignored: 'subagent without an id' };
      return {
        events: [
          {
            type: 'specialist.joined',
            label: 'A subagent joins for a bounded assignment',
            // The subagent's own stated assignment, when the bridge has read its
            // meta.json. Never invented — absent is better than guessed.
            detail: payload.description,
            worker: `agent:${payload.agent_id}`,
            role: payload.agent_type ?? 'Subagent',
          },
        ],
      };

    case 'SubagentStop':
      if (!payload.agent_id) return { events: [], ignored: 'subagent without an id' };
      return {
        events: [
          {
            type: 'specialist.left',
            label: 'Subagent finished',
            worker: `agent:${payload.agent_id}`,
          },
        ],
      };

    case 'PermissionRequest':
      return {
        events: [
          {
            type: 'review.requested',
            label: 'Waiting on your decision',
            station: 'approvals',
            work,
            question: `Allow ${payload.tool_name ?? 'this tool call'}?`,
          },
        ],
      };

    case 'Stop':
      return {
        events: [
          {
            type: 'note',
            label: 'Claude finished responding',
            detail: work ? `Turn: ${work.label}` : undefined,
          },
        ],
      };

    case 'StopFailure':
      return {
        events: [
          {
            type: 'assignment.failed',
            label: 'The turn ended with an error',
            station: 'frontdesk',
            work,
            reason: String(payload.error_message ?? payload.error_type ?? 'Unknown error').slice(0, 400),
          },
        ],
      };

    case 'Notification':
      return {
        events: [
          { type: 'note', label: `Notification: ${payload.notification_type ?? 'unspecified'}` },
        ],
      };

    default:
      return {
        events: [],
        ignored: Object.hasOwn(IGNORED, hook) ? IGNORED[hook] : 'unknown hook',
      };
  }
}

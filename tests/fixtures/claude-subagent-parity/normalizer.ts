type JsonPath = readonly (string | number)[];

interface ReplaceOperation {
  readonly kind: 'replace';
  readonly path: JsonPath;
  readonly from: unknown;
  readonly to: unknown;
}

interface DeleteOperation {
  readonly kind: 'delete';
  readonly path: JsonPath;
  readonly from: unknown;
}

interface ProjectOperation {
  readonly kind: 'project';
  readonly path: JsonPath;
  readonly indexes: readonly number[];
  readonly names: readonly string[];
}

type NormalizerOperation = ReplaceOperation | DeleteOperation | ProjectOperation;

const AGENT_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

- The agent's final report is not shown to the user — relay what matters.
- Use SendMessage with the agent's ID or name to continue a previously spawned agent with its context intact; a new Agent call starts fresh.
- Each agent type's model, reasoning effort, and tools come from its definition (\`.claude/agents/*.md\` frontmatter or SDK \`agents\`).
- \`isolation: "worktree"\` gives the agent its own git worktree (auto-cleaned if unchanged).
- Subagents run in the background by default; you'll be notified when one completes. Pass \`run_in_background: false\` only when your very next action depends on the result and nothing else could usefully happen while it runs — otherwise background it so the user can interject. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.`;

const TENON_AGENT_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.

When using the agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

- The agent's final report is not shown to the user — relay what matters.
- Use agent_message with the agent's ID to continue a previously spawned agent with its context intact; a new agent call starts fresh.
- Each agent type's model, reasoning effort, and tools come from its Tenon Role.
- \`isolation: "worktree"\` gives the agent its own git worktree (auto-cleaned if unchanged).
- Subagents run in the background by default; you'll be notified when one finishes or stops. Pass \`run_in_background: false\` only when your very next action depends on the result and nothing else could usefully happen while it runs — otherwise background it so the user can interject. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.`;

const SEND_MESSAGE_DESCRIPTION = `# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"main"\` | The main conversation (background subagents only) |
| \`"worker"\` | Any agent from \`ListAgents\` — subagent, another local Claude session |
| \`"worker [3fa9c1]"\` | Same, plus its \`[ref]\` — only when a listing or an error shows one |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to agents by name — names keep working after an agent completes (a send resumes it from its transcript). Use the raw \`agentId\` (format \`a...-...\`) from its spawn result only when the agent has no name, or when a newer agent took the name (latest wins). When relaying, don't quote the original — it's already rendered to the user.

## Cross-session

Use \`ListAgents\` to discover targets. Every row leads with the agent's \`name [ref]\` — the name IS the address; there is no separate address syntax.

\`\`\`json
{"to": "worker", "message": "check if tests pass over there"}
{"to": "worker [3fa9c1]", "message": "you, specifically"}
\`\`\`

Send the bare name. Append the \` [ref]\` only when the bare name is not enough — \`ListAgents\` shows two rows with it, or an error asks you to disambiguate. A ref you did not just read from a listing or an error will not resolve, and if the same name also names an in-process agent, the bare name always wins — use the in-process one.

A listed peer is alive and will process your message — no "busy" state; messages enqueue and drain at the receiver's next tool round. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.**

Permission boundaries are per-session: NEVER ask a peer to perform an action that was denied or blocked in your session, or that you expect your own permission settings would block — a peer doing it for you bypasses the user's permission decision (cross-session permission laundering). Route blocked work back to your user instead.`;

const TENON_AGENT_MESSAGE_DESCRIPTION = `# agent_message

Send a message to another agent.

\`\`\`json
{"to": "<agent-id>", "summary": "assign follow-up", "message": "continue with the follow-up"}
\`\`\`

| \`to\` | |
|---|---|
| \`"<agent-id>"\` | Agent by ID |
| \`"main"\` | The main conversation (background subagents only) |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Use the raw \`agentId\` from the spawn result to steer or resume an agent. When relaying, don't quote the original — it's already rendered to the user.`;

const TASK_STOP_DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- To stop an agent-team teammate, pass its agent ID ("name@team") or bare teammate name as task_id
- To stop a background agent spawned with a name, pass that name as task_id
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`;

const TENON_TASK_STOP_DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- To stop a background agent, pass its agent ID as task_id
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`;

const MODEL_DESCRIPTION = 'Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter. If omitted, uses the agent definition\'s model, or inherits from the parent. Ignored for subagent_type: "fork" — forks always inherit the parent model.';
const TENON_MODEL_DESCRIPTION = "Optional model override for this agent. Takes precedence over the Role's model. If omitted, uses the Role's model, or inherits from the parent.";
const ISOLATION_DESCRIPTION = 'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote cloud environment (always runs in background; availability is gated).';
const TENON_ISOLATION_DESCRIPTION = 'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.';
const RUN_IN_BACKGROUND_DESCRIPTION = "Agents run in the background by default; you will be notified when one completes. Set to false only when your very next action depends on this agent's result and nothing else could usefully happen while it runs — otherwise leave it in the background so the user can hand you other work.";
const TENON_RUN_IN_BACKGROUND_DESCRIPTION = "Agents run in the background by default; you will be notified when one finishes or stops. Set to false only when your very next action depends on this agent's result and nothing else could usefully happen while it runs — otherwise leave it in the background so the user can hand you other work.";

const DEFAULT_TOOL_CATALOG_MANIFEST: readonly NormalizerOperation[] = [
  { kind: 'project', path: [], indexes: [0, 3, 4], names: ['Agent', 'SendMessage', 'TaskStop'] },
  { kind: 'replace', path: [0, 'name'], from: 'Agent', to: 'agent' },
  { kind: 'replace', path: [0, 'description'], from: AGENT_DESCRIPTION, to: TENON_AGENT_DESCRIPTION },
  { kind: 'replace', path: [0, 'input_schema', 'properties', 'model', 'description'], from: MODEL_DESCRIPTION, to: TENON_MODEL_DESCRIPTION },
  { kind: 'replace', path: [0, 'input_schema', 'properties', 'model', 'enum'], from: ['sonnet', 'opus', 'haiku', 'fable'], to: ['claude-sonnet-test', 'claude-opus-test'] },
  { kind: 'replace', path: [0, 'input_schema', 'properties', 'run_in_background', 'description'], from: RUN_IN_BACKGROUND_DESCRIPTION, to: TENON_RUN_IN_BACKGROUND_DESCRIPTION },
  { kind: 'replace', path: [0, 'input_schema', 'properties', 'isolation', 'description'], from: ISOLATION_DESCRIPTION, to: TENON_ISOLATION_DESCRIPTION },
  { kind: 'replace', path: [0, 'input_schema', 'properties', 'isolation', 'enum'], from: ['worktree', 'remote'], to: ['worktree'] },
  { kind: 'replace', path: [1, 'name'], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: [1, 'description'], from: SEND_MESSAGE_DESCRIPTION, to: TENON_AGENT_MESSAGE_DESCRIPTION },
  {
    kind: 'replace',
    path: [1, 'input_schema', 'properties', 'to', 'description'],
    from: 'Recipient: a name from ListAgents (append its " [ref]" only when a listing or an error shows one), a teammate name, "main", or a background agent\'s agentId',
    to: 'Recipient: agent ID or "main"',
  },
  { kind: 'replace', path: [2, 'name'], from: 'TaskStop', to: 'task_stop' },
  { kind: 'replace', path: [2, 'description'], from: TASK_STOP_DESCRIPTION, to: TENON_TASK_STOP_DESCRIPTION },
  {
    kind: 'replace',
    path: [2, 'input_schema', 'properties', 'task_id', 'description'],
    from: 'The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.',
    to: 'The ID of the background task to stop. Background agents are also accepted by agent ID.',
  },
];

const FORK_TOOL_CATALOG_PROJECTION: readonly NormalizerOperation[] = [
  { kind: 'project', path: [], indexes: [0, 1, 2], names: ['Agent', 'SendMessage', 'TaskStop'] },
];

const FRESH_CONTEXT_MANIFEST: readonly NormalizerOperation[] = [
  { kind: 'replace', path: ['availableAgentTypes', 1], from: 'Explore', to: 'explore' },
  { kind: 'replace', path: ['availableAgentTypes', 2], from: 'Plan', to: 'plan' },
  { kind: 'replace', path: ['captures', 0, 'collaborationTools', 0], from: 'Agent', to: 'agent' },
  { kind: 'replace', path: ['captures', 0, 'collaborationTools', 1], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['captures', 0, 'collaborationTools', 2], from: 'TaskStop', to: 'task_stop' },
  { kind: 'replace', path: ['captures', 1, 'agentType'], from: 'Explore', to: 'explore' },
  { kind: 'replace', path: ['captures', 1, 'collaborationTools', 0], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['captures', 1, 'collaborationTools', 1], from: 'TaskStop', to: 'task_stop' },
  { kind: 'replace', path: ['captures', 2, 'agentType'], from: 'Plan', to: 'plan' },
  { kind: 'replace', path: ['captures', 2, 'collaborationTools', 0], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['captures', 2, 'collaborationTools', 1], from: 'TaskStop', to: 'task_stop' },
];

const EXECUTION_MESSAGING_MANIFEST: readonly NormalizerOperation[] = [
  { kind: 'replace', path: ['foreground', 0, 'tool'], from: 'Agent', to: 'agent' },
  { kind: 'replace', path: ['foreground', 1, 'agentType'], from: 'Explore', to: 'explore' },
  { kind: 'replace', path: ['foreground', 1, 'tool'], from: 'Agent', to: 'agent' },
  { kind: 'replace', path: ['foreground', 2, 'agentType'], from: 'Plan', to: 'plan' },
  { kind: 'replace', path: ['foreground', 2, 'tool'], from: 'Agent', to: 'agent' },
  { kind: 'replace', path: ['background', 'tool'], from: 'Agent', to: 'agent' },
  { kind: 'replace', path: ['sendMain', 0, 'tool'], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['sendMain', 1, 'tool'], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['sendMain', 2, 'agentType'], from: 'Explore', to: 'explore' },
  { kind: 'replace', path: ['sendMain', 2, 'tool'], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['sendMain', 3, 'agentType'], from: 'Plan', to: 'plan' },
  { kind: 'replace', path: ['sendMain', 3, 'tool'], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['continuation', 0, 'tool'], from: 'SendMessage', to: 'agent_message' },
  { kind: 'replace', path: ['continuation', 1, 'tool'], from: 'SendMessage', to: 'agent_message' },
];

export function normalizeDefaultToolCatalog(raw: unknown): unknown {
  return applyManifest(raw, DEFAULT_TOOL_CATALOG_MANIFEST);
}

export function projectForkToolCatalog(raw: unknown): unknown {
  return applyManifest(raw, FORK_TOOL_CATALOG_PROJECTION);
}

export function normalizeFreshContext(raw: unknown): unknown {
  return applyManifest(raw, FRESH_CONTEXT_MANIFEST);
}

export function normalizeExecutionMessaging(raw: unknown): unknown {
  return applyManifest(raw, EXECUTION_MESSAGING_MANIFEST);
}

export function normalizeOutputHelpers(raw: unknown): unknown {
  if (!isRecord(raw)) throw new Error('Output helper fixture must be an object');
  const backgroundLaunch = recordAt(raw, ['backgroundLaunch']);
  const foregroundGeneral = recordAt(raw, ['foregroundGeneral']);
  const backgroundNotification = recordAt(raw, ['backgroundNotification']);
  const foregroundSendMain = arrayAt(raw, ['foregroundSendMain']);
  return {
    backgroundLaunch: {
      text: replaceSlots(stringAt(backgroundLaunch, ['text']), [
        ['Use SendMessage with', 'Use agent_message with'],
        ['full subagent JSONL transcript', 'full subagent transcript'],
        ['You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.', 'You will be notified automatically when its run settles. You know nothing about its results until that notification arrives - do not report, assume, or predict them; continue other work or respond to the user in the meantime.'],
      ]),
      cacheControl: readPath(backgroundLaunch, ['cacheControl']),
    },
    foregroundGeneral: {
      content: [
        stringAt(foregroundGeneral, ['report']),
        replaceSlots(stringAt(foregroundGeneral, ['metadataText']), [
          ['use SendMessage with', 'use agent_message with'],
        ]),
      ],
      cacheControl: readPath(foregroundGeneral, ['cacheControl']),
    },
    backgroundNotification: {
      text: replaceSlots(stringAt(backgroundNotification, ['text']), [
        ['<status>completed</status>', '<status>finished</status>'],
        ['<summary>Agent "Inspect agent contract" finished</summary>', '<summary>Agent "Inspect agent contract" run finished</summary>'],
        ['<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>', '<note>A task-notification fires each time this agent run settles with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>'],
        ['<result>CHILD_MARKER</result>', '<instruction>This output records where the Agent run stopped, not whether the assignment is complete. Inspect its reported work, evidence, and gaps; then use it, resume the Agent with concrete missing work, ask the user, or report the limitation.</instruction>\n<output>CHILD_MARKER</output>'],
      ]),
    },
    foregroundSendMain: foregroundSendMain.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`Output helper fixture row ${index} must be an object`);
      const rawType = stringAt(entry, ['agentType']);
      const addressable = booleanAt(entry, ['addressable']);
      const type = rawType === 'Explore' ? 'explore' : rawType === 'Plan' ? 'plan' : rawType;
      const normalizedSuffix = addressable
        ? 'After completing your current task, decide whether/how to respond (reply via agent_message using the agentId from the immediately preceding agent tool result).'
        : 'After completing your current task, decide whether/how to respond.';
      const text = replaceSlots(stringAt(entry, ['text']), [
        ['Another Claude session sent a message while you were working:', 'Another Agent sent a message while you were working:'],
        [`<agent-message from="${rawType}">`, `<agent-message from="${type}">`],
        ['This came from another Claude session — not typed by your user', 'This came from another Agent — not typed by your user'],
        ["Treat it as a teammate's request", "Treat it as a Role's request"],
        ['CLAUDE.md', 'AGENTS.md'],
        [
          'After completing your current task, decide whether/how to respond (reply via SendMessage to the `from=` address).',
          normalizedSuffix,
        ],
      ]);
      return {
        agentType: type,
        addressable,
        text,
      };
    }),
  };
}

function applyManifest(raw: unknown, operations: readonly NormalizerOperation[]): unknown {
  const value = structuredClone(raw);
  return operations.reduce((current, operation) => {
    if (operation.kind === 'project') return project(current, operation);
    if (operation.kind === 'delete') {
      const parent = readParent(current, operation.path);
      const key = operation.path.at(-1)!;
      assertExact(readChild(parent, key, operation.path), operation.from, operation.path);
      deleteChild(parent, key, operation.path);
      return current;
    }
    const parent = readParent(current, operation.path);
    const key = operation.path.at(-1)!;
    assertExact(readChild(parent, key, operation.path), operation.from, operation.path);
    writeChild(parent, key, structuredClone(operation.to), operation.path);
    return current;
  }, value);
}

function project(value: unknown, operation: ProjectOperation): unknown {
  const selected = readPath(value, operation.path);
  if (!Array.isArray(selected)) throw new Error(`Normalizer expected an array at ${formatPath(operation.path)}`);
  if (operation.indexes.length !== operation.names.length) throw new Error('Normalizer projection metadata is inconsistent');
  const projected = operation.indexes.map((index, offset) => {
    const tool = selected[index];
    const namePath = [...operation.path, index, 'name'];
    if (!isRecord(tool)) throw new Error(`Normalizer expected a tool object at ${formatPath([...operation.path, index])}`);
    assertExact(tool.name, operation.names[offset], namePath);
    return tool;
  });
  if (operation.path.length === 0) return projected;
  const parent = readParent(value, operation.path);
  writeChild(parent, operation.path.at(-1)!, projected, operation.path);
  return value;
}

function readPath(value: unknown, path: JsonPath): unknown {
  return path.reduce((current, key, index) => readChild(current, key, path.slice(0, index + 1)), value);
}

function readParent(value: unknown, path: JsonPath): unknown {
  if (path.length === 0) throw new Error('Normalizer cannot mutate a root scalar');
  return readPath(value, path.slice(0, -1));
}

function readChild(parent: unknown, key: string | number, path: JsonPath): unknown {
  if (typeof key === 'number') {
    if (!Array.isArray(parent) || !(key in parent)) throw new Error(`Normalizer path is missing: ${formatPath(path)}`);
    return parent[key];
  }
  if (!isRecord(parent) || !Object.hasOwn(parent, key)) throw new Error(`Normalizer path is missing: ${formatPath(path)}`);
  return parent[key];
}

function writeChild(parent: unknown, key: string | number, value: unknown, path: JsonPath): void {
  if (typeof key === 'number') {
    if (!Array.isArray(parent) || !(key in parent)) throw new Error(`Normalizer path is missing: ${formatPath(path)}`);
    parent[key] = value;
    return;
  }
  if (!isRecord(parent) || !Object.hasOwn(parent, key)) throw new Error(`Normalizer path is missing: ${formatPath(path)}`);
  parent[key] = value;
}

function deleteChild(parent: unknown, key: string | number, path: JsonPath): void {
  if (typeof key === 'number') throw new Error(`Normalizer cannot delete array entries at ${formatPath(path)}`);
  if (!isRecord(parent) || !Object.hasOwn(parent, key)) throw new Error(`Normalizer path is missing: ${formatPath(path)}`);
  delete parent[key];
}

function assertExact(actual: unknown, expected: unknown, path: JsonPath): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Normalizer source mismatch at ${formatPath(path)}`);
  }
}

function replaceSlots(value: string, replacements: readonly (readonly [string, string])[]): string {
  return replacements.reduce((current, [from, to]) => {
    const first = current.indexOf(from);
    if (first < 0 || current.indexOf(from, first + from.length) >= 0) {
      throw new Error(`Output normalization slot must occur exactly once: ${from}`);
    }
    return `${current.slice(0, first)}${to}${current.slice(first + from.length)}`;
  }, value);
}

function recordAt(value: unknown, path: JsonPath): Record<string, unknown> {
  const resolved = readPath(value, path);
  if (!isRecord(resolved)) throw new Error(`Normalizer expected an object at ${formatPath(path)}`);
  return resolved;
}

function arrayAt(value: unknown, path: JsonPath): unknown[] {
  const resolved = readPath(value, path);
  if (!Array.isArray(resolved)) throw new Error(`Normalizer expected an array at ${formatPath(path)}`);
  return resolved;
}

function stringAt(value: unknown, path: JsonPath): string {
  const resolved = readPath(value, path);
  if (typeof resolved !== 'string') throw new Error(`Normalizer expected a string at ${formatPath(path)}`);
  return resolved;
}

function booleanAt(value: unknown, path: JsonPath): boolean {
  const resolved = readPath(value, path);
  if (typeof resolved !== 'boolean') throw new Error(`Normalizer expected a boolean at ${formatPath(path)}`);
  return resolved;
}

function formatPath(path: JsonPath): string {
  return path.length === 0 ? '$' : `$${path.map((part) => typeof part === 'number' ? `[${part}]` : `.${part}`).join('')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

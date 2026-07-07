import type {
  AgentIssueToolName,
  TenonAgentToolDefinition,
  TenonAgentToolDescriptionContext,
  TenonAgentToolPromptContext,
} from '../core/agentIssue';
import {
  AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS,
} from './agentIssueToolSchemas';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'Structured tool result. Mutation and runtime-control tools use TenonAgentToolResult; read tools return bounded read/search data.',
} as const;

type IssueToolStaticDefinition = Pick<
  TenonAgentToolDefinition,
  'name' | 'kind' | 'searchHint' | 'inputSchema' | 'outputSchema' | 'isReadOnly' | 'isDestructive' | 'requiresRuntimeAuthorization'
> & {
  label: string;
  descriptionText: string;
  promptGuidanceText: string;
};

function prompt(text: string): (context: TenonAgentToolPromptContext) => string {
  return (context) => [
    text,
    `Available AgentRef profiles: ${context.availableRunProfiles.map((ref) => ref.runProfile ?? 'default').join(', ') || 'default'}.`,
    'Do not use Task, Run, Project, Job, Occurrence, or Logbook concepts for durable work.',
  ].join('\n');
}

function describe(text: string): (_input: unknown, _context: TenonAgentToolDescriptionContext) => string {
  return () => text;
}

function hasRequestMode(input: unknown, mode: 'request' | 'preview'): boolean {
  return typeof input === 'object'
    && input !== null
    && 'request' in input
    && typeof (input as { request?: unknown }).request === 'object'
    && (input as { request?: { mode?: unknown } }).request?.mode === mode;
}

function isDeleteOrArchive(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || !('change' in input)) return false;
  const change = (input as { change?: { type?: unknown } }).change;
  return change?.type === 'delete' || change?.type === 'archive';
}

function issueUpdateRequiresRuntimeAuthorization(input: unknown): boolean {
  if (!hasRequestMode(input, 'request')) return false;
  if (typeof input !== 'object' || input === null || !('change' in input)) return false;
  const change = (input as { change?: { type?: unknown; patch?: Record<string, unknown> } }).change;
  if (!change) return false;
  if (['confirm', 'delete', 'archive', 'pause', 'resume', 'skip-next'].includes(String(change.type))) return true;
  if (change.type !== 'patch' || !change.patch) return false;
  return 'trigger' in change.patch
    || 'permissionMode' in change.patch
    || 'executionPolicy' in change.patch
    || 'issueTemplate' in change.patch;
}

export const AGENT_ISSUE_TOOL_DEFINITIONS: readonly TenonAgentToolDefinition[] = ([
  {
    name: 'issue_search',
    label: 'Issue Search',
    kind: 'read',
    searchHint: 'find durable agent work',
    descriptionText: 'Search Issues and Recurring Issues by durable fields, derived execution state, and Activity state.',
    promptGuidanceText: 'Use for discovery, lists, dashboards, and locating work by state. Use structured fields instead of UI view names.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_search,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => true,
    isDestructive: () => false,
    requiresRuntimeAuthorization: () => false,
  },
  {
    name: 'issue_read',
    label: 'Issue Read',
    kind: 'read',
    searchHint: 'inspect issue details',
    descriptionText: 'Read one Issue or Recurring Issue with requested context.',
    promptGuidanceText: 'Use before changing a known Issue when current revision, Activity, sub-issues, or Sessions matter.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_read,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => true,
    isDestructive: () => false,
    requiresRuntimeAuthorization: () => false,
  },
  {
    name: 'issue_create',
    label: 'Issue Create',
    kind: 'mutation',
    searchHint: 'create durable agent work',
    descriptionText: 'Create a normal Issue or Recurring Issue, or return a confirmation proposal.',
    promptGuidanceText: 'Use when the durable definition does not exist yet. Use preview for ambiguous or permission-sensitive creation.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_create,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => false,
    requiresRuntimeAuthorization: () => false,
  },
  {
    name: 'issue_update',
    label: 'Issue Update',
    kind: 'mutation',
    searchHint: 'change durable agent work',
    descriptionText: 'Update an existing Issue or Recurring Issue, including lifecycle, hierarchy, trigger, criteria, verification, and recurrence.',
    promptGuidanceText: 'Use for durable definition, lifecycle, hierarchy, schedule, criteria, verification, or recurrence changes. Use agent_session_send_message for soft execution guidance.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_update,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: isDeleteOrArchive,
    requiresRuntimeAuthorization: issueUpdateRequiresRuntimeAuthorization,
  },
  {
    name: 'agent_session_start',
    label: 'Agent Session Start',
    kind: 'runtime-control',
    searchHint: 'start issue execution',
    descriptionText: 'Request one Agent Session execution or orchestration pass for an eligible Issue.',
    promptGuidanceText: 'Use only to request execution of an existing eligible Issue. Do not mutate the Issue trigger or silently bypass blockers.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.agent_session_start,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => false,
    requiresRuntimeAuthorization: (input) => hasRequestMode(input, 'request'),
  },
  {
    name: 'agent_session_read',
    label: 'Agent Session Read',
    kind: 'read',
    searchHint: 'inspect agent execution',
    descriptionText: 'Read bounded status, latest output, or blocking question for one Agent Session.',
    promptGuidanceText: 'Use for bounded inspection or a short wait. Do not poll by default; rely on runtime notifications and Activity projections.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.agent_session_read,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => true,
    isDestructive: () => false,
    requiresRuntimeAuthorization: () => false,
  },
  {
    name: 'agent_session_send_message',
    label: 'Agent Session Send Message',
    kind: 'runtime-control',
    searchHint: 'message running agent',
    descriptionText: 'Send guidance or an answer into an active or waiting Agent Session.',
    promptGuidanceText: 'Use for guidance or answers inside an existing Session. Use issue_update when durable Issue definition changes.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.agent_session_send_message,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => false,
    requiresRuntimeAuthorization: (input) => hasRequestMode(input, 'request'),
  },
  {
    name: 'agent_session_stop',
    label: 'Agent Session Stop',
    kind: 'runtime-control',
    searchHint: 'stop agent execution',
    descriptionText: 'Request cancellation of one pending or active Agent Session.',
    promptGuidanceText: 'Use only to cancel a pending or active Session; stopping execution does not archive or delete the Issue.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.agent_session_stop,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => true,
    requiresRuntimeAuthorization: (input) => hasRequestMode(input, 'request'),
  },
] satisfies readonly IssueToolStaticDefinition[]).map((definition) => ({
  ...definition,
  description: describe(definition.descriptionText),
  promptGuidance: prompt(definition.promptGuidanceText),
  validate: () => ({ ok: true }),
  execute: () => {
    throw new Error(`${definition.name} is a contract definition and is not wired to runtime execution yet.`);
  },
}));

export function agentIssueToolDefinitionByName(name: AgentIssueToolName): TenonAgentToolDefinition {
  const definition = AGENT_ISSUE_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Unknown agent issue tool: ${name}`);
  return definition;
}

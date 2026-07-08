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
  'name' | 'kind' | 'searchHint' | 'inputSchema' | 'outputSchema' | 'isReadOnly' | 'isDestructive'
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
    'Issues are flat durable work items. Author the durable objective, scope, acceptance criteria, output, trigger, and verification policy; the Agent Session owns internal planning and execution detail.',
    'Use Issue relations only between independently user-visible Issues that each have their own lifecycle, such as true external blockers, duplicates, or related outcomes.',
  ].join('\n');
}

function describe(text: string): (_input: unknown, _context: TenonAgentToolDescriptionContext) => string {
  return () => text;
}

function isDeleteOrArchive(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || !('change' in input)) return false;
  const change = (input as { change?: { type?: unknown } }).change;
  return change?.type === 'delete' || change?.type === 'archive';
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
  },
  {
    name: 'issue_read',
    label: 'Issue Read',
    kind: 'read',
    searchHint: 'inspect issue details',
    descriptionText: 'Read one Issue or Recurring Issue with requested context.',
    promptGuidanceText: 'Use before changing a known Issue when current revision, Activity, criteria, or Sessions matter.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_read,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => true,
    isDestructive: () => false,
  },
  {
    name: 'issue_create',
    label: 'Issue Create',
    kind: 'mutation',
    searchHint: 'create durable agent work',
    descriptionText: 'Create one flat Issue or Recurring Issue for an independently user-visible durable work item.',
    promptGuidanceText: 'Use when the durable definition does not exist yet. Write the objective, scope, coverage, output shape, and verification expectations so the later Agent Session can plan and execute from the Issue snapshot. Use preview for ambiguous or broad-scope creation.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_create,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => false,
  },
  {
    name: 'issue_update',
    label: 'Issue Update',
    kind: 'mutation',
    searchHint: 'change durable agent work',
    descriptionText: 'Update an existing Issue or Recurring Issue, including lifecycle, trigger, criteria, verification, and recurrence.',
    promptGuidanceText: 'Use for durable definition, lifecycle, schedule, criteria, verification, recurrence, or true independent-Issue relation changes. Use agent_session_send_message for soft execution guidance.',
    inputSchema: AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_update,
    outputSchema: OUTPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: isDeleteOrArchive,
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

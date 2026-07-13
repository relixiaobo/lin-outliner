import { describe, expect, test } from 'bun:test';
import {
  AGENT_ISSUE_RUN_PROFILES,
  type AgentRecurringIssueOrigin,
  type AgentSessionReadResult,
  type AgentSessionTranscriptResult,
} from '../../src/core/agentIssue';
import { AGENT_ISSUE_TOOL_DEFINITIONS } from '../../src/main/agentIssueToolDefinitions';
import { AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS } from '../../src/main/agentIssueToolSchemas';
import { createAgentIssueTools, type AgentIssueToolRuntime } from '../../src/main/agentIssueTools';

const EXPECTED_TOOL_NAMES = [
  'issue_search',
  'issue_read',
  'issue_create',
  'issue_update',
  'agent_session_start',
  'agent_session_read',
  'agent_session_send_message',
  'agent_session_stop',
] as const;

describe('agent issue manager tool contracts', () => {
  test('exposes only the V1 Issue and Agent Session tool surface', () => {
    expect(AGENT_ISSUE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of AGENT_ISSUE_TOOL_DEFINITIONS) {
      expect(tool.name).not.toContain('task');
      expect(tool.name).not.toContain('run');
      expect(tool.name).not.toContain('project');
      expect(tool.name).not.toContain('cron');
      expect(tool.name).not.toContain('logbook');
      expect(tool.searchHint).toBeTruthy();
      expect(tool.description({}, descriptionContext())).toBeTruthy();
      expect(tool.promptGuidance(promptContext())).toContain('AgentRef profiles');
    }
  });

  test('keeps AgentRef narrow to Neva V1 run profiles', () => {
    expect([...AGENT_ISSUE_RUN_PROFILES]).toEqual(['default', 'background', 'verifier']);
  });

  test('describes Issue planning as durable definition authoring', () => {
    const createTool = AGENT_ISSUE_TOOL_DEFINITIONS.find((tool) => tool.name === 'issue_create');
    expect(createTool?.promptGuidance(promptContext())).toContain('Author the objective, scope, acceptance criteria, output, trigger, and verification policy');
    expect(createTool?.promptGuidance(promptContext())).toContain('the Agent Session owns internal planning and execution detail');
    expect(createTool?.promptGuidance(promptContext())).toContain('Request-mode creation of a when-ready unattended Issue is a background handoff');
    expect(createTool?.promptGuidance(promptContext())).toContain('delivers the terminal result to the immediate origin target');
    expect(createTool?.promptGuidance(promptContext())).toContain('parent Agent Session for a child, visible conversation for a root');

    const relationSchema = AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_create.properties.fields.properties.relations;
    expect(relationSchema.description).toContain('between independently managed Issues');
    expect(relationSchema.items.description).toContain('true external blocker, duplicate, or related outcome');
    expect(relationSchema.items.properties.type.description).toContain('another independently managed Issue');
  });

  test('does not expose manual Issue triggers', () => {
    const triggerTypeSchema = AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_create.properties.fields.properties.trigger.properties.type;
    expect(triggerTypeSchema.enum).toEqual(['when-ready', 'scheduled']);

    const triggerFilterSchema = AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_search.properties.filter.properties.triggerTypes.items;
    expect(triggerFilterSchema.enum).toEqual(['when-ready', 'scheduled']);
  });

  test('keeps lifecycle fields out of create/patch and makes scheduled triggers structurally complete', () => {
    const schemas = AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS;
    expect(schemas.issue_create.properties.fields.properties.status).toBeUndefined();
    expect(schemas.issue_update.properties.change.properties.patch.properties.status).toBeUndefined();
    expect(schemas.issue_create.properties.fields.properties.trigger.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: ['type', 'startAt', 'timeZone'] }),
    ]));
    expect(schemas.issue_update.properties.change.properties.patch.properties.dueDate.anyOf)
      .toContainEqual({ type: 'null' });
    expect(schemas.issue_search.properties.include.items.enum).toEqual(['activity-summary', 'session-summary']);
    expect(schemas.issue_read.properties.include.items.enum).toEqual([
      'activity',
      'sessions',
      'child-issues',
      'generated-issues',
    ]);
  });

  test('uses discriminated input and output policy schemas with required variant fields', () => {
    const fields = AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.issue_create.properties.fields.properties;
    const inputVariants = fields.input.oneOf;
    const outputVariants = fields.output.oneOf;

    expect(inputVariants.map((variant) => variant.properties.type.enum[0])).toEqual([
      'none',
      'selected-nodes',
      'node-children',
      'tag-query',
      'saved-query',
    ]);
    expect(inputVariants.find((variant) => variant.properties.type.enum[0] === 'selected-nodes')?.required)
      .toEqual(['type', 'nodeIds']);
    expect(inputVariants.find((variant) => variant.properties.type.enum[0] === 'node-children')?.required)
      .toEqual(['type', 'nodeId']);
    expect(inputVariants.find((variant) => variant.properties.type.enum[0] === 'tag-query')?.required)
      .toEqual(['type', 'tag']);
    expect(inputVariants.find((variant) => variant.properties.type.enum[0] === 'saved-query')?.required)
      .toEqual(['type', 'queryId']);

    expect(outputVariants.map((variant) => variant.properties.type.enum[0])).toEqual([
      'activity-only',
      'daily-note',
      'append-to-node',
      'create-child-under-node',
      'per-input-child',
      'replace-input',
    ]);
    expect(outputVariants.find((variant) => variant.properties.type.enum[0] === 'daily-note')?.required)
      .toEqual(['type', 'datePolicy']);
    expect(outputVariants.find((variant) => variant.properties.type.enum[0] === 'append-to-node')?.required)
      .toEqual(['type', 'nodeId']);
    expect(outputVariants.find((variant) => variant.properties.type.enum[0] === 'per-input-child')?.required)
      .toEqual(['type', 'parentNodeId']);
    expect(outputVariants.find((variant) => variant.properties.type.enum[0] === 'replace-input')?.properties.requiresConfirmation.enum)
      .toEqual([true]);
  });

  test('classifies read, mutation, runtime-control, and destructive behavior', () => {
    const byName = new Map(AGENT_ISSUE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(byName.get('issue_search')?.kind).toBe('read');
    expect(byName.get('issue_read')?.kind).toBe('read');
    expect(byName.get('agent_session_read')?.kind).toBe('read');
    expect(byName.get('issue_create')?.kind).toBe('mutation');
    expect(byName.get('issue_update')?.kind).toBe('mutation');
    expect(byName.get('agent_session_start')?.kind).toBe('runtime-control');
    expect(byName.get('agent_session_send_message')?.kind).toBe('runtime-control');
    expect(byName.get('agent_session_stop')?.kind).toBe('runtime-control');

    for (const tool of AGENT_ISSUE_TOOL_DEFINITIONS.filter((candidate) => candidate.kind === 'read')) {
      expect(tool.isReadOnly({})).toBe(true);
    }

    const request = { request: { mode: 'request' } };

    for (const tool of AGENT_ISSUE_TOOL_DEFINITIONS.filter((candidate) => (
      candidate.name === 'agent_session_start'
      || candidate.name === 'agent_session_send_message'
      || candidate.name === 'agent_session_stop'
    ))) {
      expect(tool.isReadOnly(request)).toBe(false);
    }
    expect(byName.get('agent_session_stop')?.isDestructive(request)).toBe(true);
    expect(byName.get('issue_update')?.isDestructive({ change: { type: 'archive' } })).toBe(true);
  });

  test('keeps Agent Session transcripts out of the model-facing read contract', () => {
    const includeItems = AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.agent_session_read.properties.include.items;
    expect(includeItems.enum).toEqual(['activity-summary', 'latest-output']);
    expect(includeItems.enum).not.toContain('transcript');
    expect(AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS.agent_session_read.properties.include.description)
      .toContain('available only to the renderer');

    type SessionReadExposesTranscript = 'transcript' extends keyof AgentSessionReadResult ? true : false;
    const sessionReadExposesTranscript: SessionReadExposesTranscript = false;
    expect(sessionReadExposesTranscript).toBe(false);

    type RendererTranscriptResultHasTranscript = (
      'transcript' extends keyof AgentSessionTranscriptResult ? true : false
    );
    const rendererTranscriptResultHasTranscript: RendererTranscriptResultHasTranscript = true;
    expect(rendererTranscriptResultHasTranscript).toBe(true);
  });

  test('restricts Recurring Issue origins to visible conversations', () => {
    const origin: AgentRecurringIssueOrigin = {
      type: 'conversation',
      conversationId: 'conversation:visible',
    };
    expect(origin.type).toBe('conversation');

    type RecurringOriginAcceptsAgentSession = (
      { type: 'agent-session'; agentSessionId: string } extends AgentRecurringIssueOrigin ? true : false
    );
    const recurringOriginAcceptsAgentSession: RecurringOriginAcceptsAgentSession = false;
    expect(recurringOriginAcceptsAgentSession).toBe(false);
  });

  test('describes every visible schema parameter and omits model-facing authorization tokens', () => {
    const forbiddenKeys = new Set(['userActionId', 'authorization', 'authorizationToken', 'capability', 'capabilityId']);
    for (const [toolName, schema] of Object.entries(AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS)) {
      expect(schema).toMatchObject({ type: 'object' });
      expect(Object.keys(schema)).not.toContain('oneOf');
      expect(Object.keys(schema)).not.toContain('anyOf');
      expect(Object.keys(schema)).not.toContain('allOf');
      expect(Object.keys(schema)).not.toContain('enum');
      const missing = missingDescriptions(schema, toolName);
      expect(missing).toEqual([]);
      const forbidden = forbiddenPropertyPaths(schema, toolName, forbiddenKeys);
      expect(forbidden).toEqual([]);
    }
  });

  test('wraps runtime execution through the standard tool envelope', async () => {
    const runtime: AgentIssueToolRuntime = {
      search: () => ({ rows: [{ target: { type: 'issue', id: 'issue:1' }, title: 'Demo', status: 'Triage', revision: 'rev:1', updatedAt: 1 }] }),
      read: () => ({ target: { type: 'issue', id: 'issue:1' }, issue: undefined }),
      create: () => ({ status: 'applied', targets: [{ type: 'issue', id: 'issue:1' }] }),
      update: () => ({ status: 'applied', targets: [{ type: 'issue', id: 'issue:1' }] }),
      startSession: () => ({ status: 'applied', targets: [{ type: 'agent-session', id: 'agent-session:1' }] }),
      readSession: () => null,
      sendSessionMessage: () => ({ status: 'applied', targets: [{ type: 'agent-session', id: 'agent-session:1' }] }),
      stopSession: () => ({ status: 'applied', targets: [{ type: 'agent-session', id: 'agent-session:1' }] }),
    };
    const tools = createAgentIssueTools(runtime);
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);

    const result = await (tools.find((tool) => tool.name === 'issue_search')!.execute as any)('tool-call-1', {});
    expect(result.details).toMatchObject({ ok: true, tool: 'issue_search', version: 1 });
    const visible = JSON.parse(result.content[0].text);
    expect(visible.data).toContain('"issue:1"');

    const missingSession = await (tools.find((tool) => tool.name === 'agent_session_read')!.execute as any)('tool-call-2', { agentSessionId: 'missing' });
    expect(missingSession.details).toMatchObject({
      ok: false,
      tool: 'agent_session_read',
      error: { code: 'agent_issue_tool_failed' },
    });
  });

  test('keeps routing origins and execution snapshots out of model-visible read results', async () => {
    const issue = {
      id: 'issue:1',
      title: 'Private routing fixture',
      status: { name: 'Started', category: 'started' },
      relations: [],
      trigger: { type: 'when-ready' },
      permissionMode: 'unattended',
      confirmation: { confirmedBy: { type: 'system' }, confirmedAt: 1 },
      origin: { type: 'conversation', conversationId: 'conversation:private-origin' },
      revision: 'rev:1',
      createdAt: 1,
      updatedAt: 2,
    } as const;
    const session = {
      id: 'agent-session:1',
      issueId: issue.id,
      delegate: { type: 'default-agent' },
      state: 'active',
      source: { type: 'runtime-action', actor: { type: 'system' } },
      issueSnapshot: issue,
      inputSnapshot: { scope: { type: 'none' }, resolvedAt: 1 },
      latestOutput: 'Visible only when requested.',
      revision: 'rev:session',
      createdAt: 1,
      updatedAt: 2,
    } as const;
    const runtime: AgentIssueToolRuntime = {
      search: () => ({ rows: [] }),
      read: () => ({
        target: { type: 'issue', id: issue.id },
        issue: issue as never,
        sessions: [session as never],
      }),
      create: () => ({ status: 'applied', targets: [] }),
      update: () => ({ status: 'applied', targets: [] }),
      startSession: () => ({ status: 'applied', targets: [] }),
      readSession: () => ({ agentSession: session as never }),
      sendSessionMessage: () => ({ status: 'applied', targets: [] }),
      stopSession: () => ({ status: 'applied', targets: [] }),
    };
    const tools = createAgentIssueTools(runtime);

    const issueRead = await (tools.find((tool) => tool.name === 'issue_read')!.execute as any)(
      'tool-call-read',
      { target: { type: 'issue', id: issue.id }, include: ['sessions'] },
    );
    const issueVisible = JSON.parse(issueRead.content[0].text).data as string;
    expect(issueVisible).not.toContain('conversation:private-origin');
    expect(issueVisible).not.toContain('issueSnapshot');

    const sessionRead = await (tools.find((tool) => tool.name === 'agent_session_read')!.execute as any)(
      'tool-call-session-read',
      { agentSessionId: session.id },
    );
    const sessionVisible = JSON.parse(sessionRead.content[0].text).data as string;
    expect(sessionVisible).not.toContain('conversation:private-origin');
    expect(sessionVisible).not.toContain('issueSnapshot');
    expect(sessionVisible).not.toContain('Visible only when requested.');
  });
});

function descriptionContext() {
  return {
    actor: { type: 'agent', agentId: 'built-in:tenon:assistant' } as const,
    permissionMode: 'interactive' as const,
    isNonInteractiveSession: false,
  };
}

function promptContext() {
  return {
    actor: { type: 'agent', agentId: 'built-in:tenon:assistant' } as const,
    permissionMode: 'interactive' as const,
    availableRunProfiles: [{ type: 'default-agent' as const }],
  };
}

function missingDescriptions(schema: unknown, path: string): string[] {
  if (!isRecord(schema)) return [];
  const missing: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, child] of Object.entries(properties)) {
    const childPath = `${path}.${name}`;
    if (!isRecord(child) || typeof child.description !== 'string' || child.description.trim() === '') {
      missing.push(childPath);
    }
    missing.push(...missingDescriptions(child, childPath));
  }
  if (isRecord(schema.items)) {
    missing.push(...missingDescriptions(schema.items, `${path}[]`));
  }
  return missing;
}

function forbiddenPropertyPaths(schema: unknown, path: string, forbiddenKeys: Set<string>): string[] {
  if (!isRecord(schema)) return [];
  const forbidden: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, child] of Object.entries(properties)) {
    const childPath = `${path}.${name}`;
    if (forbiddenKeys.has(name)) forbidden.push(childPath);
    forbidden.push(...forbiddenPropertyPaths(child, childPath, forbiddenKeys));
  }
  if (isRecord(schema.items)) {
    forbidden.push(...forbiddenPropertyPaths(schema.items, `${path}[]`, forbiddenKeys));
  }
  return forbidden;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

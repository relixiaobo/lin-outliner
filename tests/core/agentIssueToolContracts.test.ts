import { describe, expect, test } from 'bun:test';
import { AGENT_ISSUE_RUN_PROFILES } from '../../src/core/agentIssue';
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

  test('classifies read, mutation, runtime-control, and authorization behavior', () => {
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
      expect(tool.requiresRuntimeAuthorization({})).toBe(false);
    }

    const request = { request: { mode: 'request' } };
    const preview = { request: { mode: 'preview' } };
    for (const tool of AGENT_ISSUE_TOOL_DEFINITIONS.filter((candidate) => candidate.kind !== 'read')) {
      expect(tool.isReadOnly(request)).toBe(false);
      expect(tool.requiresRuntimeAuthorization(request)).toBe(true);
      expect(tool.requiresRuntimeAuthorization(preview)).toBe(false);
    }
    expect(byName.get('agent_session_stop')?.isDestructive(request)).toBe(true);
    expect(byName.get('issue_update')?.isDestructive({ change: { type: 'archive' } })).toBe(true);
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

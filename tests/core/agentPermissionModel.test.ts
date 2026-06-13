import { describe, expect, test } from 'bun:test';
import {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  actionKindRuleValue,
  defaultActionDecision,
  effectiveActionDecision,
  agentToolActionKindProfile,
  isReadOnlyActionKind,
  readOnlyAgentToolNames,
  safetyModeDefaultActionDecision,
  type AgentToolActionKind,
} from '../../src/core/agentPermissionModel';
import type { AgentSafetyMode } from '../../src/core/types';
import { evaluateAgentToolPermission, type AgentPermissionDecision } from '../../src/main/agentPermissions';
import type { ToolActionDescriptor } from '../../src/main/agentToolPermissionRules';

const SAFETY_MODES: readonly AgentSafetyMode[] = ['ask_first', 'balanced', 'full_access'];
const EMPTY_OVERRIDES = { allow: [], ask: [], deny: [] };
const WORKSPACE_ROOT = '/tmp/workspace';

describe('agent permission model', () => {
  test('has a safety-mode decision for every supported action kind', () => {
    for (const actionKind of SUPPORTED_AGENT_TOOL_ACTION_KINDS) {
      expect(['allow', 'ask', 'deny']).toContain(defaultActionDecision(actionKind));
      for (const safetyMode of SAFETY_MODES) {
        expect(['allow', 'ask', 'deny']).toContain(
          effectiveActionDecision(actionKind, safetyMode, EMPTY_OVERRIDES),
        );
      }
    }
  });

  test('full access displays the same routine allows the runtime uses', () => {
    const allowedInFullAccess: readonly AgentToolActionKind[] = [
      'web.fetch',
      'file.delete.allowed_file_area',
      'shell.project_script',
      'shell.dependency_install',
      'git.publish_remote',
    ];

    for (const actionKind of allowedInFullAccess) {
      expect(effectiveActionDecision(actionKind, 'full_access', EMPTY_OVERRIDES)).toBe('allow');
    }
    expect(effectiveActionDecision('deploy.publish_remote', 'full_access', EMPTY_OVERRIDES)).toBe('ask');
    expect(effectiveActionDecision('shell.sandbox_override', 'full_access', EMPTY_OVERRIDES)).toBe('ask');
    expect(effectiveActionDecision('file.read.sensitive_local_path', 'full_access', EMPTY_OVERRIDES)).toBe('ask');
    expect(effectiveActionDecision('shell.unknown', 'full_access', EMPTY_OVERRIDES)).toBe('deny');
  });

  test('partitions read-only action kinds and derives safe catalog tools', () => {
    for (const actionKind of SUPPORTED_AGENT_TOOL_ACTION_KINDS) {
      expect(typeof isReadOnlyActionKind(actionKind)).toBe('boolean');
    }

    expect(isReadOnlyActionKind('file.read.allowed_file_area')).toBe(true);
    expect(isReadOnlyActionKind('web.search')).toBe(true);
    expect(isReadOnlyActionKind('agent.delegate.status')).toBe(true);
    expect(isReadOnlyActionKind('file.edit.allowed_file_area')).toBe(false);
    expect(isReadOnlyActionKind('agent.skill.invoke')).toBe(false);
    expect(isReadOnlyActionKind('agent.delegate.spawn')).toBe(false);

    const tools = readOnlyAgentToolNames();
    expect(tools).toEqual(expect.arrayContaining([
      'file_read',
      'file_glob',
      'file_grep',
      'node_read',
      'node_search',
      'web_search',
      'web_fetch',
      'recall',
      'AgentStatus',
    ]));
    expect(tools).not.toContain('file_write');
    expect(tools).not.toContain('file_edit');
    expect(tools).not.toContain('node_edit');
    expect(tools).not.toContain('operation_history');
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('skill');
    expect(tools).not.toContain('Agent');
    expect(tools).not.toContain('AgentSend');
    expect(tools).not.toContain('AgentStop');
    expect(tools).not.toContain('config');

    expect(readOnlyAgentToolNames(['file_read', 'file_write', 'AgentStatus'])).toEqual([
      'file_read',
      'AgentStatus',
    ]);
    expect(agentToolActionKindProfile('operation_history', { action: 'list' })).toEqual(['outline.read']);
    expect(agentToolActionKindProfile('operation_history', { action: 'undo' })).toEqual(['outline.edit']);
  });

  test('explicit exceptions take precedence over mode defaults', () => {
    expect(effectiveActionDecision('web.fetch', 'full_access', {
      allow: [actionKindRuleValue('web.fetch')],
      ask: [actionKindRuleValue('web.fetch')],
      deny: [actionKindRuleValue('web.fetch')],
    })).toBe('deny');
    expect(effectiveActionDecision('web.fetch', 'full_access', {
      allow: [actionKindRuleValue('web.fetch')],
      ask: [actionKindRuleValue('web.fetch')],
      deny: [],
    })).toBe('ask');
    expect(effectiveActionDecision('web.fetch', 'balanced', {
      allow: [actionKindRuleValue('web.fetch')],
      ask: [],
      deny: [],
    })).toBe('allow');
  });

  test('runtime fallback decisions match the shared safety-mode model for common descriptors', () => {
    const cases = [
      {
        actionKind: 'web.fetch',
        toolName: 'web_fetch',
        args: { url: 'https://example.com' },
      },
      {
        actionKind: 'file.write.allowed_file_area',
        toolName: 'file_write',
        args: { file_path: `${WORKSPACE_ROOT}/a.txt`, content: 'a' },
      },
      {
        actionKind: 'file.delete.allowed_file_area',
        toolName: 'bash',
        args: { command: 'rm ./dist/a.txt' },
      },
      {
        actionKind: 'shell.project_script',
        toolName: 'bash',
        args: { command: 'npm test' },
      },
      {
        actionKind: 'git.publish_remote',
        toolName: 'bash',
        args: { command: 'git push origin codex/foo' },
      },
    ] as const;

    for (const safetyMode of SAFETY_MODES) {
      for (const item of cases) {
        const decision = evaluateAgentToolPermission({
          toolName: item.toolName,
          args: item.args,
          policy: { workspaceRoot: WORKSPACE_ROOT, safetyMode },
        });
        expect(decision.behavior, `${safetyMode}:${item.actionKind}`).toBe(
          safetyModeDefaultActionDecision(item.actionKind, safetyMode),
        );
      }
    }
  });

  test('routine descriptor defaults are injected from the shared action model', () => {
    const cases = [
      { toolName: 'web_fetch', args: { url: 'https://example.com' } },
      { toolName: 'file_write', args: { file_path: `${WORKSPACE_ROOT}/a.txt`, content: 'a' } },
      { toolName: 'bash', args: { command: 'npm test' } },
      { toolName: 'bash', args: { command: 'git push origin codex/foo' } },
    ] as const;

    for (const item of cases) {
      const descriptor = firstDescriptor(evaluateAgentToolPermission({
        toolName: item.toolName,
        args: item.args,
        policy: { workspaceRoot: WORKSPACE_ROOT, safetyMode: 'balanced' },
      }));
      expect(descriptor.defaultDecision, descriptor.actionKind).toBe(defaultActionDecision(descriptor.actionKind));
    }
  });

  test('context-specific descriptors can be stricter than the routine action default', () => {
    const outsideRead = firstDescriptor(evaluateAgentToolPermission({
      toolName: 'file_read',
      args: { file_path: '/tmp/outside.txt' },
      policy: { workspaceRoot: WORKSPACE_ROOT, safetyMode: 'full_access' },
    }));
    expect(outsideRead.actionKind).toBe('file.read.outside_allowed_file_area');
    expect(defaultActionDecision(outsideRead.actionKind)).toBe('ask');
    expect(outsideRead.defaultDecision).toBe('deny');

    const inlineEdit = firstDescriptor(evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: "sed -i '' s/a/b/ a.txt" },
      policy: { workspaceRoot: WORKSPACE_ROOT, safetyMode: 'balanced' },
    }));
    expect(inlineEdit.actionKind).toBe('file.edit.allowed_file_area');
    expect(defaultActionDecision(inlineEdit.actionKind)).toBe('allow');
    expect(inlineEdit.defaultDecision).toBe('ask');
  });
});

function firstDescriptor(decision: AgentPermissionDecision): ToolActionDescriptor {
  const descriptor = decision.descriptor ?? decision.descriptors?.[0];
  expect(descriptor).toBeDefined();
  return descriptor as ToolActionDescriptor;
}

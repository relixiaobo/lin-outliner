import { describe, expect, test } from 'bun:test';
import {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  actionKindRuleValue,
  defaultActionDecision,
  effectiveActionDecision,
  safetyModeDefaultActionDecision,
  type AgentToolActionKind,
} from '../../src/core/agentPermissionModel';
import type { AgentSafetyMode } from '../../src/core/types';
import { evaluateAgentToolPermission } from '../../src/main/agentPermissions';

const SAFETY_MODES: readonly AgentSafetyMode[] = ['ask_first', 'balanced', 'full_access'];
const EMPTY_OVERRIDES = { allow: [], ask: [], deny: [] };

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
    const workspaceRoot = '/tmp/workspace';
    const cases = [
      {
        actionKind: 'web.fetch',
        toolName: 'web_fetch',
        args: { url: 'https://example.com' },
      },
      {
        actionKind: 'file.edit.allowed_file_area',
        toolName: 'file_write',
        args: { file_path: '/tmp/workspace/a.txt', content: 'a' },
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
          policy: { workspaceRoot, safetyMode },
        });
        expect(decision.behavior, `${safetyMode}:${item.actionKind}`).toBe(
          safetyModeDefaultActionDecision(item.actionKind, safetyMode),
        );
      }
    }
  });
});

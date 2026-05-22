import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  evaluateAgentToolPermission,
  matchesAgentToolRule,
} from '../../src/main/agentPermissions';
import { executeAgentSkillShellCommand } from '../../src/main/agentSkillShell';

describe('agent permissions', () => {
  test('trusted mode allows bash by default', () => {
    const decision = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'bun test tests/core' },
      policy: {
        workspaceRoot: '/tmp/workspace',
      },
    });

    expect(decision).toMatchObject({ allow: true, access: 'execute', preapproved: false });
  });

  test('trusted mode allows scoped cleanup commands', () => {
    const decision = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'rm -rf ./dist' },
      policy: {
        workspaceRoot: '/tmp/workspace',
      },
    });

    expect(decision.allow).toBe(true);
  });

  test('blocks obviously destructive bash commands even in trusted mode', () => {
    const rootDelete = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'rm -rf /' },
      policy: { workspaceRoot: '/tmp/workspace' },
    });
    const workspaceDelete = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'rm -rf .' },
      policy: { workspaceRoot: '/tmp/workspace' },
    });

    expect(rootDelete.allow).toBe(false);
    expect(rootDelete.code).toBe('dangerous_root_delete');
    expect(workspaceDelete.allow).toBe(false);
    expect(workspaceDelete.code).toBe('dangerous_root_delete');
  });

  test('enforces workspace boundary for file writes', () => {
    const workspaceRoot = '/tmp/workspace';
    const decision = evaluateAgentToolPermission({
      toolName: 'file_write',
      args: { file_path: path.join('/tmp', 'outside.txt'), content: 'nope' },
      policy: { workspaceRoot },
    });

    expect(decision.allow).toBe(false);
    expect(decision.code).toBe('path_outside_workspace');
  });

  test('can explicitly allow outside workspace reads', () => {
    const decision = evaluateAgentToolPermission({
      toolName: 'file_read',
      args: { file_path: '/tmp/outside.txt' },
      policy: {
        workspaceRoot: '/tmp/workspace',
        allowOutsideWorkspaceRead: true,
      },
    });

    expect(decision.allow).toBe(true);
  });

  test('matches allowed-tools rules for restricted mode preapproval', () => {
    expect(matchesAgentToolRule('Bash(git diff:*)', 'bash', { command: 'git diff -- src/main.ts' })).toBe(true);
    expect(matchesAgentToolRule('Bash(git diff:*)', 'bash', { command: 'git status --short' })).toBe(false);
    expect(matchesAgentToolRule('Bash(git diff:*)', 'bash', { command: 'git different' })).toBe(false);
    expect(matchesAgentToolRule('file_read', 'file_read', { file_path: '/tmp/workspace/a.ts' })).toBe(true);

    const allowed = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'git diff -- src/main.ts' },
      policy: {
        mode: 'restricted',
        workspaceRoot: '/tmp/workspace',
        preapprovedToolRules: ['Bash(git diff:*)'],
      },
    });
    const blocked = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'git status --short' },
      policy: {
        mode: 'restricted',
        workspaceRoot: '/tmp/workspace',
        preapprovedToolRules: ['Bash(git diff:*)'],
      },
    });

    expect(allowed).toMatchObject({ allow: true, preapproved: true });
    expect(blocked).toMatchObject({ allow: false, code: 'tool_not_preapproved' });
  });

  test('skill shell expansion uses the same restricted preapproval rules', async () => {
    await expect(executeAgentSkillShellCommand({
      command: 'echo should-not-run',
      localRoot: '/tmp/workspace',
      permissionMode: 'restricted',
      allowedTools: [],
    })).rejects.toThrow('requires a matching skill allowed-tools rule');
  });
});

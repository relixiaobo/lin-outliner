import { describe, expect, test } from 'bun:test';
import { resolveAgentPermissionAsk } from '../../src/main/agentPermissionAskResolver';
import { evaluateAgentToolPermission } from '../../src/main/agentPermissions';

describe('agent permission ask resolver', () => {
  test('asks the user for every commit when interaction is available', async () => {
    const decision = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'git push origin main' },
      policy: { workspaceRoot: '/tmp/workspace' },
    });
    expect(decision.behavior).toBe('ask');
    if (decision.behavior !== 'ask') throw new Error('expected ask');

    await expect(resolveAgentPermissionAsk({
      decision,
      interactionAvailable: true,
    })).resolves.toEqual({ outcome: 'needs_user' });
  });

  test('does not auto-allow commits when no interaction channel exists', async () => {
    const decision = evaluateAgentToolPermission({
      toolName: 'web_fetch',
      args: { url: 'https://example.com' },
      policy: { workspaceRoot: '/tmp/workspace' },
    });
    expect(decision.behavior).toBe('allow');

    const commit = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'curl -X POST https://example.com -d hello' },
      policy: { workspaceRoot: '/tmp/workspace' },
    });
    expect(commit.behavior).toBe('ask');
    if (commit.behavior !== 'ask') throw new Error('expected ask');

    await expect(resolveAgentPermissionAsk({
      decision: commit,
      interactionAvailable: false,
    })).resolves.toEqual({ outcome: 'needs_user' });
  });

  test('aborted runs fail closed before asking', async () => {
    const controller = new AbortController();
    controller.abort();
    const decision = evaluateAgentToolPermission({
      toolName: 'bash',
      args: { command: 'git push origin main' },
      policy: { workspaceRoot: '/tmp/workspace' },
    });
    if (decision.behavior !== 'ask') throw new Error('expected ask');

    await expect(resolveAgentPermissionAsk({
      decision,
      interactionAvailable: true,
      signal: controller.signal,
    })).resolves.toEqual({
      outcome: 'block',
      reason: 'run_aborted',
      message: 'Permission request was cancelled before approval.',
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { resolveAgentPermissionAsk } from '../../src/main/agentPermissionAskResolver';
import type { AgentPermissionAskDecision } from '../../src/main/agentPermissions';

const legacyAskDecision: AgentPermissionAskDecision = {
  behavior: 'ask',
  access: 'execute',
  code: 'legacy_ask',
  preapproved: false,
  reason: 'Legacy ask decision.',
  request: {
    title: 'Approve legacy action?',
    target: 'legacy action',
    details: [],
  },
};

describe('agent permission ask resolver', () => {
  test('keeps legacy ask decisions interactive when possible', async () => {
    await expect(resolveAgentPermissionAsk({
      decision: legacyAskDecision,
      interactionAvailable: true,
    })).resolves.toEqual({ outcome: 'needs_user' });
  });

  test('keeps legacy ask decisions fail-closed without interaction', async () => {
    await expect(resolveAgentPermissionAsk({
      decision: legacyAskDecision,
      interactionAvailable: false,
    })).resolves.toEqual({ outcome: 'needs_user' });
  });

  test('aborted legacy asks fail closed before asking', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(resolveAgentPermissionAsk({
      decision: legacyAskDecision,
      interactionAvailable: true,
      signal: controller.signal,
    })).resolves.toEqual({
      outcome: 'block',
      reason: 'run_aborted',
      message: 'Permission request was cancelled before approval.',
    });
  });
});

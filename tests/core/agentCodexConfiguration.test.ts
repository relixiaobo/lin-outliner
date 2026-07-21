import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_AGENT_ROLES,
  resolveChildConfiguration,
  type AgentRole,
  type EffectiveThreadConfiguration,
} from '../../src/core/agent/configuration';
import { THREAD_GOAL_STATUSES, type ThreadGoal } from '../../src/core/agent/goal';

const parent: EffectiveThreadConfiguration = {
  profileName: 'coding',
  developerInstructions: ['Parent instructions'],
  model: 'parent-model',
  reasoningEffort: 'high',
  tools: ['file_read', 'file_edit', 'bash'],
  skills: ['repo-rules'],
  plugins: ['github'],
  mcpServers: ['docs'],
};

describe('Codex Agent Core configuration and Goal contracts', () => {
  test('keeps Profiles, Roles, and child Threads as separate concepts', () => {
    expect(BUILT_IN_AGENT_ROLES).toEqual(['default', 'worker', 'explorer']);
    const role: AgentRole = {
      name: 'explorer',
      source: 'builtIn',
      description: 'Read-only repository exploration.',
      developerInstructions: 'Inspect and report.',
      nicknameCandidates: ['Scout'],
      overrides: {
        model: 'explorer-model',
        reasoningEffort: 'medium',
        tools: ['file_read', 'file_edit', 'web_search'],
        skills: ['repo-rules', 'role-added-skill'],
        plugins: ['github', 'role-added-plugin'],
        mcpServers: ['docs', 'role-added-server'],
      },
    };

    const child = resolveChildConfiguration(parent, { role });
    expect(child.profileName).toBe('coding');
    expect(child.model).toBe('explorer-model');
    expect(child.tools).toEqual(['file_read', 'file_edit']);
    expect(child.tools).not.toContain('web_search');
    expect(child.skills).toEqual(['repo-rules']);
    expect(child.plugins).toEqual(['github']);
    expect(child.mcpServers).toEqual(['docs']);
    expect(child.developerInstructions).toEqual(['Parent instructions', 'Inspect and report.']);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.tools)).toBe(true);
    expect(Object.isFrozen(child.skills)).toBe(true);
    expect(Object.isFrozen(child.plugins)).toBe(true);
    expect(Object.isFrozen(child.mcpServers)).toBe(true);
  });

  test('defines one Goal per Thread with the exact Codex lifecycle statuses', () => {
    expect(THREAD_GOAL_STATUSES).toEqual([
      'active',
      'paused',
      'blocked',
      'usageLimited',
      'budgetLimited',
      'complete',
    ]);
    const goal: ThreadGoal = {
      threadId: '018f0f24-7b2e-7a3f-8a4b-123456789abc',
      objective: 'Replace Agent Core',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 20,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(goal.threadId).toBeTruthy();
    expect(goal.status).toBe('active');
  });
});

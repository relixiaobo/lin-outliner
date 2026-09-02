import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_AGENT_ROLES,
  resolveChildConfiguration,
  type AgentRole,
  type EffectiveThreadConfiguration,
} from '../../src/core/agent/configuration';
import { composeStablePrompt } from '../../src/main/agent/context/stablePrompt';
import type { Thread } from '../../src/core/agent/protocol';
import { THREAD_GOAL_STATUSES, type ThreadGoal } from '../../src/core/agent/goal';

const parent: EffectiveThreadConfiguration = {
  profileName: 'coding',
  developerInstructions: ['Parent instructions'],
  model: 'parent-model',
  reasoningEffort: 'high',
  tools: ['file_read', 'file_edit', 'bash'],
  skills: ['repo-rules'],
  preloadedSkills: [],
  plugins: ['github'],
  mcpServers: ['docs'],
};

describe('Codex Agent Core configuration and Goal contracts', () => {
  test('keeps Profiles, Roles, and child Threads as separate concepts', () => {
    expect(BUILT_IN_AGENT_ROLES).toEqual(['default', 'explorer', 'plan']);
    const role: AgentRole = {
      name: 'explorer',
      source: 'builtIn',
      description: 'Read-only repository exploration.',
      developerInstructions: 'Inspect and report.',
      overrides: {
        tools: ['file_read', 'file_edit', 'web_search'],
        skills: ['repo-rules', 'role-added-skill'],
        plugins: ['github', 'role-added-plugin'],
        mcpServers: ['docs', 'role-added-server'],
      },
    };

    const child = resolveChildConfiguration(parent, {
      role,
      execution: { model: 'explorer-model', reasoningEffort: 'medium' },
    });
    expect(child.profileName).toBe('coding');
    expect(child.model).toBe('explorer-model');
    expect(child.tools).toEqual(['file_read', 'file_edit']);
    expect(child.tools).not.toContain('web_search');
    expect(child.skills).toEqual(['repo-rules']);
    expect(child.preloadedSkills).toEqual(['repo-rules']);
    expect(child.plugins).toEqual(['github']);
    expect(child.mcpServers).toEqual(['docs']);
    expect(child.developerInstructions).toEqual(['Inspect and report.']);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.tools)).toBe(true);
    expect(Object.isFrozen(child.skills)).toBe(true);
    expect(Object.isFrozen(child.preloadedSkills)).toBe(true);
    expect(Object.isFrozen(child.plugins)).toBe(true);
    expect(Object.isFrozen(child.mcpServers)).toBe(true);
  });

  test('lets wildcard parents preserve all capabilities while Roles can still narrow them', () => {
    const wildcardParent: EffectiveThreadConfiguration = {
      ...parent,
      skills: ['*'],
    };
    const inherited = resolveChildConfiguration(wildcardParent, {
      role: {
        name: 'default',
        source: 'builtIn',
        description: 'Default child.',
        developerInstructions: 'Work on the task.',
      },
    });
    const narrowed = resolveChildConfiguration(wildcardParent, {
      role: {
        name: 'researcher',
        source: 'user',
        description: 'Research child.',
        developerInstructions: 'Research the task.',
        overrides: { skills: ['research'] },
      },
    });

    expect(inherited.skills).toEqual(['*']);
    expect(inherited.preloadedSkills).toEqual([]);
    expect(narrowed.skills).toEqual(['research']);
    expect(narrowed.preloadedSkills).toEqual(['research']);
  });

  test('starts child context from Role instructions without parent instructions or transcript guidance', () => {
    const role: AgentRole = {
      name: 'explorer',
      source: 'builtIn',
      description: 'Explore the assigned task.',
      developerInstructions: 'Role-only instructions',
    };
    const childConfiguration = resolveChildConfiguration(parent, { role });
    const child: Thread = {
      id: '018f0f24-7b2e-7a3f-8a4b-123456789abd',
      sessionId: parent.profileName ?? 'child-session',
      parentThreadId: '018f0f24-7b2e-7a3f-8a4b-123456789abc',
      forkedFromId: null,
      agentNickname: null,
      agentRole: role.name,
      name: 'Child',
      preview: '',
      ephemeral: false,
      source: 'collaboration',
      threadSource: 'subagent',
      modelProvider: 'openai',
      cwd: '/workspace',
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'idle' },
      historyMode: 'full',
    };

    expect(childConfiguration.developerInstructions).toEqual(['Role-only instructions']);
    expect(childConfiguration.developerInstructions).not.toContain('Parent instructions');

    const prompt = composeStablePrompt({
      thread: child,
      configuration: childConfiguration,
      transcriptIndexPath: '/workspace/transcripts/index.tsv',
    });
    expect(prompt.text).toContain('Role-only instructions');
    expect(prompt.text).not.toContain('Parent instructions');
    expect(prompt.text).not.toContain('# Past sessions');
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

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../src/core/types';
import {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  composeAgentPrompt,
  composeAgentPromptBlocks,
} from '../../src/main/agentSystemPrompt';

function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'reviewer',
    displayName: 'Reviewer',
    source: 'project',
    rootDir: '/workspace/.agents/agents/reviewer',
    agentFile: '/workspace/.agents/agents/reviewer/AGENT.md',
    description: 'Reviews implementation plans.',
    body: 'REVIEWER_AGENT_BODY',
    ...overrides,
  };
}

describe('agent system prompt composer', () => {
  test('keeps the prompt blocks in stable layer order', () => {
    expect(composeAgentPromptBlocks(def(), {
      mode: 'member',
      mention: 'reviewer',
      profileSkillSections: ['SKILL_BODY'],
      capabilities: { nodeMemory: true, pastChats: false },
    }).map((block) => block.id)).toEqual([
      'system-context',
      'communication-and-safety',
      'skill-dependencies',
      'filesystem-access',
      'memory',
      'persona',
      'profile-skills',
    ]);
  });

  test('the default agent prompt is composed from universal firmware, memory module, and Neva persona', () => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('# System context');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('# Communication and safety');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('# Skill dependencies');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('# Filesystem access');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('This Run has Full Access');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('# Memory');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('Use node_search over the d- tag family');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('Use past_chats to read raw prior chat spans');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('Use dream');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('You are Neva.');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('still water');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('agree in order to be agreeable');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain('Do not silently replace the skill');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT.indexOf('# System context')).toBeLessThan(DEFAULT_AGENT_SYSTEM_PROMPT.indexOf('# Memory'));
    expect(DEFAULT_AGENT_SYSTEM_PROMPT.indexOf('# Memory')).toBeLessThan(DEFAULT_AGENT_SYSTEM_PROMPT.indexOf('You are Neva.'));
  });

  test('keeps dynamic state and tool manuals out of the stable prompt', () => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('# Outliner');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('# Web');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('# Local files and shell');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('second brain');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('atomic nodes');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('node_read');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('node_edit');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('%%node:id%%');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('file_read');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('web_search');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('YYYY-MM-DD');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('workspace root');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('Local workspace root');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('active panel id');
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('Today node id');
  });

  test('custom member agents now receive universal firmware plus their persona', () => {
    const prompt = composeAgentPrompt(def(), {
      mode: 'member',
      mention: 'reviewer',
      capabilities: { nodeMemory: true, pastChats: false },
    });
    expect(prompt).toContain('# System context');
    expect(prompt).toContain('# Communication and safety');
    expect(prompt).toContain('This Run has Full Access');
    expect(prompt).toContain('# Skill dependencies');
    expect(prompt).toContain('verify whether the dependency is already available');
    expect(prompt).toContain('You are "Reviewer" (@reviewer).');
    expect(prompt).toContain('# Agent instructions');
    expect(prompt).toContain('REVIEWER_AGENT_BODY');
    expect(prompt.indexOf('# System context')).toBeLessThan(prompt.indexOf('You are "Reviewer"'));
  });

  test('describes Full Access and native boundaries for every Run', () => {
    const prompt = composeAgentPrompt(def(), { mode: 'member' });
    expect(prompt).toContain('This Run has Full Access');
    expect(prompt).toContain('Native OS authorization and provider or service login still apply');
    expect(prompt).toContain('place it under the Run workdir');
    expect(prompt).toContain('without limiting other Full Access operations');
    expect(prompt).not.toContain('Restricted');
    expect(prompt).not.toContain('folder capability');
  });

  test('memory module follows effective tool capability', () => {
    const memoryPrompt = composeAgentPrompt(def(), {
      mode: 'member',
    });
    expect(memoryPrompt).toContain('# Memory');
    expect(memoryPrompt).toContain('Use node_search over the d- tag family');
    expect(memoryPrompt).toContain('Use past_chats to read raw prior chat spans');
    expect(memoryPrompt).not.toContain('Use dream');

    const noMemoryPrompt = composeAgentPrompt(def({ tools: ['web_search'] }), {
      mode: 'member',
    });
    expect(noMemoryPrompt).not.toContain('# Memory');
    expect(noMemoryPrompt).not.toContain('Use node_search over the d- tag family');

    const normalizedRulePrompt = composeAgentPrompt(def({ tools: ['node_search(query)', 'node_read', 'past_chats'] }), {
      mode: 'member',
    });
    expect(normalizedRulePrompt).toContain('# Memory');
    expect(normalizedRulePrompt).toContain('Use node_search over the d- tag family');
    expect(normalizedRulePrompt).toContain('Use past_chats to read raw prior chat spans');
  });
});

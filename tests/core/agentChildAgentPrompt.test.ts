import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../src/core/types';
import { composeAgentPrompt } from '../../src/main/agentSystemPrompt';

function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'researcher',
    source: 'project',
    rootDir: '/workspace/.agents/agents/researcher',
    agentFile: '/workspace/.agents/agents/researcher/AGENT.md',
    description: 'Focused child run for research, analysis, and execution.',
    body: '',
    ...overrides,
  };
}

describe('composeAgentPrompt child mode', () => {
  test('layers universal firmware, memory capability, and the headless child directive', () => {
    const prompt = composeAgentPrompt(def(), { mode: 'child' });
    expect(prompt).toContain('# System context');
    expect(prompt).toContain('# Communication and safety');
    expect(prompt).toContain('# Memory');
    expect(prompt).toContain('<system-reminder>');
    expect(prompt).toContain('Use node_search over the d- tag family');
    expect(prompt).toContain('Use past_chats to read raw prior chat spans');
    expect(prompt).not.toContain('Use dream');
    expect(prompt).toContain('You are a Tenon child agent');
    expect(prompt).toContain('# Child run rules');
    expect(prompt).toContain('never ask the user questions');
    expect(prompt).toContain('Agent type: researcher');
    expect(prompt).not.toContain('You are Neva');
    expect(prompt.indexOf('# System context')).toBeLessThan(prompt.indexOf('# Memory'));
    expect(prompt.indexOf('# Memory')).toBeLessThan(prompt.indexOf('You are a Tenon child agent'));
  });

  test('an empty-body definition adds no Agent instructions block', () => {
    expect(composeAgentPrompt(def(), { mode: 'child' })).not.toContain('# Agent instructions');
  });

  test('a custom definition appends its persona body after the child directive', () => {
    const prompt = composeAgentPrompt(def({ name: 'researcher', body: 'Specialize in citation chasing.' }), { mode: 'child' });
    expect(prompt).toContain('Agent type: researcher');
    expect(prompt).toContain('# Agent instructions');
    expect(prompt).toContain('Specialize in citation chasing.');
    expect(prompt).toContain('# System context');
    expect(prompt.indexOf('# Child run rules')).toBeLessThan(prompt.indexOf('# Agent instructions'));
  });

  test('omits the memory module when the child definition cannot use node memory or past chats', () => {
    const prompt = composeAgentPrompt(def({ tools: ['web_search'] }), { mode: 'child' });
    expect(prompt).not.toContain('# Memory');
    expect(prompt).toContain('You are a Tenon child agent');
  });
});

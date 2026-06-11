import { describe, expect, test } from 'bun:test';
import { buildFreshAgentSystemPrompt } from '../../src/main/agentDelegation';
import type { AgentDefinition } from '../../src/core/types';

// A fresh child run is the SAME Tenon agent in headless mode: it reuses the
// shared-core system prompt and layers a child run identity + directive (and the
// definition's persona body, if any) on top. See [[child run-prompt-unification]].

function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'general',
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/general',
    description: 'General-purpose focused child run for research, analysis, and execution.',
    body: '',
    ...overrides,
  };
}

describe('buildFreshAgentSystemPrompt', () => {
  test('reuses the shared core + a headless child run directive', () => {
    const prompt = buildFreshAgentSystemPrompt(def());
    // Child run identity + directive.
    expect(prompt).toContain('You are a Tenon child run');
    expect(prompt).toContain('# Child run rules');
    expect(prompt).toContain('never ask the user questions');
    expect(prompt).toContain('Agent type: general');
    // The shared base capabilities (not a stripped-down persona).
    expect(prompt).toContain('# Outliner');
    expect(prompt).toContain('node_edit');
    expect(prompt).toContain('file_read');
    // But NOT the main chat agent's user-facing identity / memory framing.
    expect(prompt).not.toContain('You are Tenon Agent');
    expect(prompt).not.toContain('# Memory');
  });

  test('general carries no persona body, so it adds no Agent instructions block', () => {
    expect(buildFreshAgentSystemPrompt(def())).not.toContain('# Agent instructions');
  });

  test('a custom definition appends its persona body as Agent instructions', () => {
    const prompt = buildFreshAgentSystemPrompt(def({ name: 'researcher', body: 'Specialize in citation chasing.' }));
    expect(prompt).toContain('Agent type: researcher');
    expect(prompt).toContain('# Agent instructions');
    expect(prompt).toContain('Specialize in citation chasing.');
    // Still on top of the shared base.
    expect(prompt).toContain('# Outliner');
  });
});

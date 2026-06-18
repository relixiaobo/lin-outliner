import { describe, expect, test } from 'bun:test';
import { builtInDefinitionToAuthoringInput } from '../../src/renderer/ui/agent/agentProfileInput';
import type { AgentDefinitionView } from '../../src/renderer/api/types';

function builtInView(overrides: Partial<AgentDefinitionView> = {}): AgentDefinitionView {
  return {
    agentId: 'built-in:tenon:assistant',
    name: 'assistant',
    displayName: 'Neva',
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/assistant',
    description: 'Default Tenon assistant profile.',
    tools: ['*'],
    model: 'inherit',
    body: 'You are Neva.',
    writable: true,
    ...overrides,
  };
}

describe('builtInDefinitionToAuthoringInput', () => {
  test('a model-only change preserves the user customizations (tools, skills, persona)', () => {
    // The user has restricted tools, picked skills, and rewritten the persona.
    const view = builtInView({
      displayName: 'Lin',
      description: 'My editing partner',
      body: 'You are Lin. Be terse.',
      tools: ['file_read', 'bash'],
      disallowedTools: ['web_fetch'],
      skills: ['skill-a'],
      model: 'anthropic/claude-opus-4-8',
      effort: 'high',
    });
    // The chip changes ONLY the model; everything else must round-trip so the
    // runtime's diff-against-base never clears the overlay.
    const input = { ...builtInDefinitionToAuthoringInput(view), model: 'openai/gpt-5.4' };
    expect(input).toEqual({
      name: 'Lin',
      description: 'My editing partner',
      body: 'You are Lin. Be terse.',
      model: 'openai/gpt-5.4',
      effort: 'high',
      permissionMode: undefined,
      maxTurns: undefined,
      tools: ['file_read', 'bash'],
      disallowedTools: ['web_fetch'],
      skills: ['skill-a'],
      background: undefined,
    });
  });

  test('the unrestricted `*` tool sentinel and `inherit` model map to undefined (never stored)', () => {
    const input = builtInDefinitionToAuthoringInput(builtInView());
    expect(input.tools).toBeUndefined();
    expect(input.model).toBeUndefined();
    // `name` mirrors the DISPLAY name (the stable `name` is the memory anchor).
    expect(input.name).toBe('Neva');
    expect(input.body).toBe('You are Neva.');
  });

  test('falls back to the stable name when no display name is set', () => {
    const input = builtInDefinitionToAuthoringInput(builtInView({ displayName: undefined }));
    expect(input.name).toBe('assistant');
  });

  test('a restriction that merely contains `*` is kept (only exactly `[*]` is unrestricted)', () => {
    // A mixed list is still a restriction — collapsing it to undefined would wipe the
    // user's tool limits on a model-only chip edit.
    expect(builtInDefinitionToAuthoringInput(builtInView({ tools: ['file_read', '*'] })).tools).toEqual(['file_read']);
    expect(builtInDefinitionToAuthoringInput(builtInView({ tools: ['file_read', 'bash'] })).tools).toEqual(['file_read', 'bash']);
    expect(builtInDefinitionToAuthoringInput(builtInView({ tools: ['*'] })).tools).toBeUndefined();
  });
});

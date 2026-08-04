import { describe, expect, test } from 'bun:test';
import type { AgentProviderSettingsView } from '../../src/renderer/api/types';
import { translationModelGroups, translationModelName } from '../../src/renderer/ui/preview/translationModelChoices';

// A gateway names its models by route — `Codex / OpenAI_1 / GPT 5.6 Sonnet` — and
// the leading segments repeat the provider the option is already grouped under.
// Left whole, a closed menu shows the prefix and truncates the model away, which
// drops the only part the user was choosing.

function settings(models: Array<{ id: string; name: string }>): AgentProviderSettingsView {
  return {
    activeProviderId: 'cc-switch',
    providers: [{
      providerId: 'cc-switch',
      baseUrl: 'http://127.0.0.1:8787/v1',
      enabled: true,
      hasApiKey: true,
      auth: { credentialed: true, hasStoredKey: true, authKind: 'api-key' },
    }],
    availableProviders: [{
      providerId: 'cc-switch',
      models,
      credentialed: true,
    }],
    imageGeneration: {},
    agent: { disabledSkills: [], additionalSkillDirectories: [] },
  } as unknown as AgentProviderSettingsView;
}

function labels(models: Array<{ id: string; name: string }>): string[] {
  return translationModelGroups(settings(models))[0]?.models.map((model) => model.label) ?? [];
}

describe('translation model choices', () => {
  test('shows the model, not the route that reaches it', () => {
    expect(labels([{ id: 'a', name: 'Codex / OpenAI_1 / GPT 5.6 Sonnet' }]))
      .toEqual(['GPT 5.6 Sonnet']);
  });

  test('leaves a plain name alone', () => {
    expect(labels([{ id: 'a', name: 'gpt-5.6-sonnet' }])).toEqual(['gpt-5.6-sonnet']);
  });

  test('keeps full names when shortening them would collide', () => {
    // The same model through two accounts. Abbreviating both to "GPT 5.6 Sonnet"
    // would offer two options that read identically, so the group keeps its
    // routes — being long is better than being indistinguishable.
    expect(labels([
      { id: 'a', name: 'Codex / OpenAI_1 / GPT 5.6 Sonnet' },
      { id: 'b', name: 'Codex / OpenAI_2 / GPT 5.6 Sonnet' },
    ])).toEqual([
      'Codex / OpenAI_1 / GPT 5.6 Sonnet',
      'Codex / OpenAI_2 / GPT 5.6 Sonnet',
    ]);
  });

  test('a collision in one group does not lengthen a different model', () => {
    expect(labels([
      { id: 'a', name: 'Codex / OpenAI_1 / GPT 5.6 Sonnet' },
      { id: 'b', name: 'Codex / OpenAI_1 / Claude Fable 5' },
    ])).toEqual(['GPT 5.6 Sonnet', 'Claude Fable 5']);
  });

  test('tolerates stray spacing and trailing separators', () => {
    expect(labels([{ id: 'a', name: 'Codex /  OpenAI_1  / GPT 5.6 Sonnet /' }]))
      .toEqual(['GPT 5.6 Sonnet']);
  });

  test('a stored value is displayed the same way the menu displays it', () => {
    // The fallback and unavailable rows show a model that is not in the menu; if
    // they abbreviated differently, one model would read two ways.
    expect(translationModelName('cc-switch/Codex / OpenAI_1 / GPT 5.6 Sonnet')).toBe('GPT 5.6 Sonnet');
    expect(translationModelName('openai/gpt-4o')).toBe('gpt-4o');
    expect(translationModelName('gpt-4o')).toBe('gpt-4o');
  });
});

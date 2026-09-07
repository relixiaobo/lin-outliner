import { describe, expect, test } from 'bun:test';
import type {
  AgentModelOption,
  AgentProviderOption,
  AgentProviderSettingsView,
} from '../../src/core/types';
import {
  buildModelChoices,
  flattenModelChoices,
  isFloatingModelSelection,
} from '../../src/renderer/ui/agent/modelChoices';

function model(id: string): AgentModelOption {
  return { id, name: id.toUpperCase(), reasoning: false, supportedThinkingLevels: [], contextWindow: 0, maxTokens: 0 };
}

function catalog(providerId: string, modelIds: readonly string[]): AgentProviderOption {
  return {
    providerId,
    authKind: 'api-key',
    hasEnvApiKey: false,
    envKeyNames: [],
    capabilities: [],
    models: modelIds.map(model),
  } as AgentProviderOption;
}

function settings(
  providers: readonly { id: string; models: readonly string[]; usable?: boolean }[],
): AgentProviderSettingsView {
  return {
    providers: providers.map((provider) => ({
      providerId: provider.id,
      enabled: true,
      hasApiKey: provider.usable !== false,
      auth: { authKind: 'api-key', credentialed: provider.usable !== false, hasStoredKey: provider.usable !== false },
    })),
    availableProviders: providers.map((provider) => catalog(provider.id, provider.models)),
    agent: { additionalSkillDirectories: [], disabledSkills: [] },
    imageGeneration: {},
  } as AgentProviderSettingsView;
}

describe('isFloatingModelSelection', () => {
  test('treats the inherit sentinel and an unset value as floating', () => {
    expect(isFloatingModelSelection('inherit')).toBe(true);
    expect(isFloatingModelSelection('')).toBe(true);
    expect(isFloatingModelSelection('   ')).toBe(true);
  });

  test('a named model is pinned, including one that resolves to the ranked head', () => {
    expect(isFloatingModelSelection('anthropic/claude-5')).toBe(false);
    expect(isFloatingModelSelection('claude-5')).toBe(false);
  });
});

describe('buildModelChoices', () => {
  const twoProviders = settings([
    { id: 'openai', models: ['gpt-5', 'gpt-4'] },
    { id: 'anthropic', models: ['claude-5', 'claude-4'] },
  ]);

  test('a floating selection still resolves the connection head, so the pill can name it', () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'inherit' });
    expect(choices.floating).toBe(true);
    expect(choices.resolvedProviderId).toBe('openai');
    expect(choices.resolvedModelId).toBe('gpt-5');
  });

  test('floating and pinned-to-the-head resolve identically — only `floating` separates them', () => {
    const asFloating = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'inherit' });
    const asPinned = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'openai/gpt-5' });
    expect(asPinned.resolvedModelId).toBe(asFloating.resolvedModelId);
    expect(asPinned.resolvedProviderId).toBe(asFloating.resolvedProviderId);
    expect([asFloating.floating, asPinned.floating]).toEqual([true, false]);
  });

  test("the selection's own provider leads, so its models need no connection switch", () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'inherit' });
    expect(choices.groups.map((group) => group.providerId)).toEqual(['openai', 'anthropic']);
  });

  test('remaining providers follow the preferred order, not settings order', () => {
    const three = settings([
      { id: 'openrouter', models: ['auto'] },
      { id: 'openai', models: ['gpt-5'] },
      { id: 'anthropic', models: ['claude-5'] },
    ]);
    const choices = buildModelChoices(three, { modelProvider: '', model: 'inherit' });
    expect(choices.groups.map((group) => group.providerId)).toEqual(['anthropic', 'openai', 'openrouter']);
  });

  test('provider origin is suppressed on a single connection and shown on several', () => {
    const one = settings([{ id: 'anthropic', models: ['claude-5'] }]);
    expect(buildModelChoices(one, { modelProvider: 'anthropic', model: 'inherit' }).showProviderLabel).toBe(false);
    expect(buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'inherit' }).showProviderLabel).toBe(true);
  });

  test('an unusable provider contributes no models', () => {
    const mixed = settings([
      { id: 'anthropic', models: ['claude-5'] },
      { id: 'openai', models: ['gpt-5'], usable: false },
    ]);
    const choices = buildModelChoices(mixed, { modelProvider: 'anthropic', model: 'inherit' });
    expect(choices.groups.map((group) => group.providerId)).toEqual(['anthropic']);
    expect(choices.showProviderLabel).toBe(false);
  });

  test('a pinned model the catalog dropped stays selectable rather than vanishing', () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'openai/gpt-legacy' });
    const openai = choices.groups.find((group) => group.providerId === 'openai');
    expect(openai?.models[0]?.option.id).toBe('gpt-legacy');
    expect(choices.resolvedModelId).toBe('gpt-legacy');
  });

  test('choices carry the canonical provider-qualified value a selection persists', () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'inherit' });
    expect(flattenModelChoices(choices).map((choice) => choice.value)).toEqual([
      'openai/gpt-5',
      'openai/gpt-4',
      'anthropic/claude-5',
      'anthropic/claude-4',
    ]);
  });

  // `inherit` resolves against `thread.modelProvider`, so the head must be keyed
  // there. Clamping the effort or labelling the row against the model being
  // un-pinned instead lets main reject the commit, which strands the Thread.
  test('the connection head is the sentinel target, not the model being un-pinned', () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'openai/gpt-4' });
    expect(choices.resolvedModelId).toBe('gpt-4');
    expect(choices.connectionHead?.id).toBe('gpt-5');
  });

  test('the head follows the Thread connection even when the pin points elsewhere', () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'anthropic/claude-4' });
    expect(choices.resolvedProviderId).toBe('anthropic');
    expect(choices.connectionHead?.id).toBe('gpt-5');
  });

  // Without this the row still renders off the aggregate count and commits a
  // sentinel main cannot satisfy.
  test('a connection listing no models offers no head to float to', () => {
    const empty = settings([
      { id: 'anthropic', models: ['claude-5'] },
      { id: 'openai', models: [] },
    ]);
    const choices = buildModelChoices(empty, { modelProvider: 'openai', model: 'inherit' });
    expect(choices.connectionHead).toBeUndefined();
    expect(choices.modelCount).toBeGreaterThan(0);
  });

  test('an unqualified stored id is reported verbatim, not replaced by the head', () => {
    const choices = buildModelChoices(twoProviders, { modelProvider: 'openai', model: 'gpt-4o-mini' });
    expect(choices.resolvedModelId).toBe('gpt-4o-mini');
    expect(choices.resolvedOption?.id).toBe('gpt-4o-mini');
    expect(choices.connectionHead?.id).toBe('gpt-5');
  });

  test('no settings yet still reports the stored selection without inventing models', () => {
    const choices = buildModelChoices(null, { modelProvider: 'openai', model: 'openai/gpt-5' });
    expect(choices.groups).toEqual([]);
    expect(choices.resolvedModelId).toBe('gpt-5');
    expect(choices.floating).toBe(false);
  });
});

import { afterEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AgentCapabilitySettingsView,
  AgentProviderSettingsView,
  SkillDefinition,
} from '../../src/renderer/api/types';
import type { SettingsOpenTarget } from '../../src/core/settingsWindow';
import type { UrlPageTranslationPreferences } from '../../src/core/urlPageTranslation';
import { resetTranslationLanguagePreferenceForTests } from '../../src/renderer/ui/preview/translationLanguagePreference';
import { resetUrlPageTranslationPreferencesForTests } from '../../src/renderer/ui/preview/urlPageTranslationPreferences';

mock.module('../../src/renderer/ui/agent/providerIcon', () => ({
  providerIconSvg: () => '<svg></svg>',
}));
mock.module('../../CHANGELOG.md?raw', () => ({ default: '# Changelog\n\n## [Unreleased]\n' }));

const { AgentSettingsView } = await import('../../src/renderer/ui/agent/AgentSettingsView');

interface Rendered {
  cleanup: () => void;
  document: Document;
  reports: unknown[];
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = [
  'document',
  'window',
  'navigator',
  'Event',
  'HTMLElement',
  'MouseEvent',
  'Node',
] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  resetTranslationLanguagePreferenceForTests();
  resetUrlPageTranslationPreferencesForTests();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

test('provider enable is optimistic, live while pending, and does not request a probe', async () => {
  const write = deferred<AgentProviderSettingsView>();
  const calls: Array<Record<string, unknown> | undefined> = [];
  const rendered = await renderSettings({ page: 'services' }, async (command, args) => {
    if (command === 'agent_upsert_provider_config') {
      calls.push(args);
      return write.promise;
    }
    return fixtureCommand(command);
  });
  const control = switchFor(rendered.document, 'Enable or disable OpenAI');

  await act(async () => {
    control.click();
    await Promise.resolve();
  });

  expect(control.disabled).toBe(false);
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(calls[0]).toMatchObject({
    provider: { providerId: 'openai', enabled: false },
    probeConnection: false,
  });

  await act(async () => {
    write.resolve(providerSettings(false));
    await settle();
  });
});

// The switch says nothing about the endpoint, so it must send exactly what the row
// stores — including none. It used to fall through to the catalog's default Base
// URL for a row that has none (a key saved with the field left empty, the normal
// case), which main reads as an endpoint change: flipping the switch silently
// dropped a good connection verdict and wrote in a URL the user never entered.
test('the enable toggle never invents a Base URL for a row that stores none', async () => {
  const stored = providerSettings(true);
  const withoutBaseUrl: AgentProviderSettingsView = {
    ...stored,
    providers: [{ providerId: 'openai', enabled: true, hasApiKey: true }],
  };
  const write = deferred<AgentProviderSettingsView>();
  const calls: Array<Record<string, unknown> | undefined> = [];
  const rendered = await renderSettings({ page: 'services' }, async (command, args) => {
    if (command === 'agent_get_provider_settings') return withoutBaseUrl;
    if (command === 'agent_upsert_provider_config') {
      calls.push(args);
      return write.promise;
    }
    return fixtureCommand(command);
  });
  const control = switchFor(rendered.document, 'Enable or disable OpenAI');

  await act(async () => {
    control.click();
    await Promise.resolve();
  });

  expect(calls[0]?.provider).toMatchObject({ providerId: 'openai', baseUrl: null, enabled: false });

  await act(async () => {
    write.resolve(withoutBaseUrl);
    await settle();
  });
});

test('two provider clicks before render serialize as off then on', async () => {
  const writes = [deferred<AgentProviderSettingsView>(), deferred<AgentProviderSettingsView>()];
  const calls: Array<Record<string, unknown> | undefined> = [];
  const rendered = await renderSettings({ page: 'services' }, async (command, args) => {
    if (command === 'agent_upsert_provider_config') {
      const index = calls.push(args) - 1;
      return writes[index]!.promise;
    }
    return fixtureCommand(command);
  });
  const control = switchFor(rendered.document, 'Enable or disable OpenAI');

  await act(async () => {
    control.click();
    control.click();
    await Promise.resolve();
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(calls).toHaveLength(1);

  await act(async () => {
    writes[0]!.resolve(providerSettings(false));
    await settle();
  });
  expect(calls).toHaveLength(2);
  expect(calls.map((args) => (args?.provider as { enabled?: boolean }).enabled)).toEqual([false, true]);

  await act(async () => {
    writes[1]!.resolve(providerSettings(true));
    await settle();
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
});

test('provider actions cannot overtake an optimistic enable write with a stale snapshot', async () => {
  const imageWrite = deferred<AgentProviderSettingsView>();
  const enabledWrite = deferred<AgentProviderSettingsView>();
  const calls: string[] = [];
  const rendered = await renderSettings({ page: 'services' }, async (command) => {
    if (command === 'agent_update_image_generation_settings') {
      calls.push(command);
      return imageWrite.promise;
    }
    if (command === 'agent_upsert_provider_config') {
      calls.push(command);
      return enabledWrite.promise;
    }
    return fixtureCommand(command);
  });
  const imageModel = rendered.document.querySelector<HTMLSelectElement>(
    'select[aria-label="Default model"]',
  );
  const control = switchFor(rendered.document, 'Enable or disable OpenAI');

  await act(async () => {
    if (!imageModel) throw new Error('Missing default image model control');
    Object.defineProperty(imageModel, 'value', { configurable: true, value: 'openai/gpt-test' });
    imageModel.dispatchEvent(new Event('change', { bubbles: true }));
    control.click();
    await Promise.resolve();
  });

  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(calls).toEqual(['agent_update_image_generation_settings']);

  await act(async () => {
    imageWrite.resolve({
      ...providerSettings(true),
      imageGeneration: { defaultModel: 'openai/gpt-test' },
    });
    await settle();
  });
  expect(calls).toEqual([
    'agent_update_image_generation_settings',
    'agent_upsert_provider_config',
  ]);
  expect(control.getAttribute('aria-checked')).toBe('false');

  await act(async () => {
    enabledWrite.resolve(providerSettings(false));
    await settle();
  });
  expect(control.getAttribute('aria-checked')).toBe('false');
});

test('a failed provider toggle reverts and reports at its row', async () => {
  const write = deferred<AgentProviderSettingsView>();
  const rendered = await renderSettings({ page: 'services' }, async (command) => {
    if (command === 'agent_upsert_provider_config') return write.promise;
    return fixtureCommand(command);
  });
  const control = switchFor(rendered.document, 'Enable or disable OpenAI');

  await act(async () => {
    control.click();
    await Promise.resolve();
    write.reject(new Error('disk detail that must not reach the row'));
    await settle();
  });

  expect(control.getAttribute('aria-checked')).toBe('true');
  const alert = rendered.document.querySelector('.inset-row-feedback [role="alert"]');
  expect(alert?.textContent).toBe('Could not update OpenAI. Try again.');
  expect(alert?.textContent).not.toContain('disk detail');
  expect(rendered.reports).toHaveLength(1);
});

test('two local Skill clicks before render persist disabled then enabled', async () => {
  const writes = [deferred<AgentProviderSettingsView>(), deferred<AgentProviderSettingsView>()];
  const calls: Array<Record<string, unknown> | undefined> = [];
  const rendered = await renderSettings({ page: 'skills' }, async (command, args) => {
    if (command === 'agent_list_all_skills') return [localSkill('notes')];
    if (command === 'agent_update_runtime_settings') {
      const index = calls.push(args) - 1;
      return writes[index]!.promise;
    }
    return fixtureCommand(command);
  });
  const control = switchFor(rendered.document, 'Toggle notes');

  await act(async () => {
    control.click();
    control.click();
    await Promise.resolve();
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(calls).toHaveLength(1);

  await act(async () => {
    writes[0]!.resolve(settingsWithDisabled(['notes']));
    await settle();
  });
  expect(calls).toHaveLength(2);
  expect(calls.map((args) => (args?.settings as { disabledSkills?: string[] }).disabledSkills))
    .toEqual([['notes'], []]);

  await act(async () => {
    writes[1]!.resolve(settingsWithDisabled([]));
    await settle();
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
});

test('a failed concurrent capability removal restores only its own rule', async () => {
  const first = deferred<AgentCapabilitySettingsView>();
  const second = deferred<AgentCapabilitySettingsView>();
  const rendered = await renderSettings({ category: 'agent' }, async (command, args) => {
    if (command === 'agent_get_capability_settings') {
      return { blocks: ['Command(first)', 'Command(second)'], diagnostics: [] };
    }
    if (command === 'agent_apply_capability_settings_patch') {
      const removed = (args?.patch as { removeBlocks?: string[] }).removeBlocks?.[0];
      return removed === 'Command(first)' ? first.promise : second.promise;
    }
    return fixtureCommand(command);
  });
  const buttons = [...rendered.document.querySelectorAll<HTMLButtonElement>(
    '.settings-security-section button',
  )].filter((button) => button.textContent?.trim() === 'Remove');

  await act(async () => {
    buttons[0]!.click();
    buttons[1]!.click();
    await Promise.resolve();
  });
  expect(rendered.document.body.textContent).not.toContain('Command(first)');
  expect(rendered.document.body.textContent).not.toContain('Command(second)');

  await act(async () => {
    first.resolve({ blocks: ['Command(second)'], diagnostics: [] });
    second.reject(new Error('write failed'));
    await settle();
  });

  expect(rendered.document.body.textContent).not.toContain('Command(first)');
  expect(rendered.document.body.textContent).toContain('Command(second)');
  expect(rendered.document.querySelector('.inset-row-feedback [role="alert"]')?.textContent)
    .toBe('Could not remove this block. Try again.');
});

test('a stale Preview switch failure cannot override the latest click', async () => {
  resetTranslationLanguagePreferenceForTests();
  resetUrlPageTranslationPreferencesForTests();
  const initial: UrlPageTranslationPreferences = {
    translationModel: null,
    autoTranslateEpubs: false,
    autoTranslateUrls: false,
  };
  const writes = [deferred<UrlPageTranslationPreferences>(), deferred<UrlPageTranslationPreferences>()];
  const payloads: UrlPageTranslationPreferences[] = [];
  const rendered = await renderSettings(
    { category: 'preview' },
    async (command) => fixtureCommand(command),
    {
      initialTranslationLanguage: 'en',
      initialUrlPageTranslationPreferences: initial,
      onTranslationLanguageChanged: () => () => undefined,
      onUrlPageTranslationPreferencesChanged: () => () => undefined,
      setUrlPageTranslationPreferences: (preferences: UrlPageTranslationPreferences) => {
        const index = payloads.push(preferences) - 1;
        return writes[index]!.promise;
      },
    },
  );
  const control = switchFor(rendered.document, 'Translate webpages automatically');

  await act(async () => {
    control.click();
    control.click();
    await Promise.resolve();
  });
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(payloads).toEqual([{ ...initial, autoTranslateUrls: true }]);

  await act(async () => {
    writes[0]!.reject(new Error('stale write failed'));
    await settle();
  });
  expect(payloads[1]).toEqual(initial);
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(rendered.document.querySelector('.inset-row-feedback [role="alert"]')).toBeNull();

  await act(async () => {
    writes[1]!.resolve(initial);
    await settle();
  });
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(rendered.document.querySelector('.inset-row-feedback [role="alert"]')).toBeNull();
});

async function renderSettings(
  target: SettingsOpenTarget,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  linOverrides: Record<string, unknown> = {},
): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const reports: unknown[] = [];
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      invoke,
      onSettingsNavigate: () => () => undefined,
      onSettingsChanged: () => () => undefined,
      reportRendererError: (report: unknown) => { reports.push(report); },
      ...linOverrides,
    },
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(<AgentSettingsView initialTarget={target} onApplied={async () => undefined} onClose={() => undefined} />);
    await settle();
  });
  const rendered = { cleanup: () => act(() => root.unmount()), document, reports };
  mounted.push(rendered);
  return rendered;
}

async function fixtureCommand(command: string): Promise<unknown> {
  if (command === 'agent_get_provider_settings') return providerSettings(true);
  if (command === 'agent_get_capability_settings') return { blocks: [], diagnostics: [] };
  if (command === 'agent_list_all_skills') return [];
  if (command === 'agent_managed_skill_list' || command === 'agent_managed_skill_check_updates') {
    return { ok: true, value: [] };
  }
  if (command === 'agent_managed_skill_catalog') {
    return { ok: true, value: { status: 'fresh', entries: [] } };
  }
  if (command === 'memory_settings_get') {
    return {
      status: {
        featureMode: 'off',
        featureModeGeneration: 1,
        resetEpoch: 0,
        memoryVisibilityGeneration: 1,
        lastSuccessfulRunAt: null,
        lastError: null,
        pendingJobs: 0,
        strayTaggedNodeCount: 0,
      },
      thread: null,
    };
  }
  throw new Error(`Unexpected command: ${command}`);
}

function providerSettings(enabled: boolean): AgentProviderSettingsView {
  return {
    activeProviderId: enabled ? 'openai' : undefined,
    providers: [{
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      enabled,
      hasApiKey: true,
    }],
    availableProviders: [{
      providerId: 'openai',
      authKind: 'api-key',
      hasEnvApiKey: false,
      envKeyNames: ['OPENAI_API_KEY'],
      defaultBaseUrl: 'https://api.openai.com/v1',
      models: [],
    }],
    agent: {
      additionalSkillDirectories: [],
      subagentTokenBudget: null,
      providerTimeoutMs: null,
      providerMaxRetries: null,
      providerMaxRetryDelayMs: null,
      providerCacheRetention: 'short',
      disabledSkills: [],
    },
    imageGeneration: {},
  };
}

function settingsWithDisabled(disabledSkills: string[]): AgentProviderSettingsView {
  const settings = providerSettings(true);
  return { ...settings, agent: { ...settings.agent, disabledSkills } };
}

function localSkill(name: string): SkillDefinition {
  return {
    name,
    source: 'user',
    rootDir: `/skills/${name}`,
    skillFile: `/skills/${name}/SKILL.md`,
    description: `${name} description`,
    hasUserSpecifiedDescription: true,
    userInvocable: true,
    modelInvocable: true,
    allowedTools: [],
    argumentNames: [],
    execution: 'inline',
    contentLength: 10,
    body: '',
  };
}

function switchFor(document: Document, label: string): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
  if (!control) throw new Error(`Missing switch: ${label}`);
  return control;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installDomGlobals(window: Window): void {
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

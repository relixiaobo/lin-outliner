import { afterEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AgentCapabilitySettingsView,
  AgentProviderSettingsView,
  AgentSkillSettingsView,
  SkillDefinition,
} from '../../src/renderer/api/types';
import type { SettingsOpenTarget } from '../../src/core/settingsWindow';
import { previewOperationsBridge } from '../helpers/previewOperationsBridge';

mock.module('../../src/renderer/ui/agent/providerIcon', () => ({
  providerIconSvg: () => '<svg></svg>',
}));
const { ModelsManager } = await import('../../src/renderer/ui/configuration/ModelsManager');
const { SkillsManager } = await import('../../src/renderer/ui/configuration/SkillsManager');
const { AccessManager } = await import('../../src/renderer/ui/configuration/AccessManager');
const { PreviewDataPanel } = await import('../../src/renderer/ui/agent/PreviewDataPanel');

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
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

test('provider enable is optimistic, live while pending, and does not request a probe', async () => {
  const write = deferred<AgentProviderSettingsView>();
  const calls: Array<Record<string, unknown> | undefined> = [];
  const rendered = await renderSettings({ destination: 'models' }, async (command, args) => {
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
  const rendered = await renderSettings({ destination: 'models' }, async (command, args) => {
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
  const rendered = await renderSettings({ destination: 'models' }, async (command, args) => {
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
  const rendered = await renderSettings({ destination: 'models' }, async (command) => {
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
    'select[aria-label="Default image model"]',
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
  const rendered = await renderSettings({ destination: 'models' }, async (command) => {
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

test.each(['local', 'managed'])('two %s Skill clicks before render use only the file-backed queue', async (source) => {
  const writes = [deferred<AgentSkillSettingsView>(), deferred<AgentSkillSettingsView>()];
  const calls: Array<Record<string, unknown> | undefined> = [];
  const rendered = await renderSettings({ destination: 'skills' }, async (command, args) => {
    if (command === 'agent_list_all_skills') return source === 'local' ? [localSkill('notes')] : [];
    if (source === 'managed' && (command === 'agent_managed_skill_list' || command === 'agent_managed_skill_check_updates')) {
      return { ok: true, value: [{ id: 'notes', revision: 'revision', name: 'notes', description: 'Notes',
        status: 'installed', userInvocable: true, repository: 'https://github.com/public/skills', subdirectory: 'notes',
        trackingRef: 'main', recommended: false, scripts: [], compatibility: { status: 'compatible', appVersion: '0.1.0' },
        active: { contentHash: 'a'.repeat(64), commit: 'a'.repeat(40), installedAt: 1, fileCount: 1, totalBytes: 10 },
      }] };
    }
    if (command === 'agent_update_skill_settings') {
      const index = calls.push(args) - 1;
      return writes[index]!.promise;
    }
    return fixtureCommand(command);
  });
  const control = switchFor(rendered.document, source === 'local' ? 'Toggle notes' : 'Enable notes');

  await act(async () => {
    control.click();
    control.click();
    await Promise.resolve();
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(calls).toHaveLength(1);

  await act(async () => {
    writes[0]!.resolve({ disabledSkills: ['notes'], sourceBindings: [] });
    await settle();
  });
  expect(calls).toHaveLength(2);
  expect(calls.map((args) => (args?.settings as { disabledSkills?: string[] }).disabledSkills))
    .toEqual([['notes'], []]);

  await act(async () => {
    writes[1]!.resolve({ disabledSkills: [], sourceBindings: [] });
    await settle();
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
});

test('a refresh started before a Skill write cannot overwrite its result', async () => {
  const refresh = deferred<AgentSkillSettingsView>();
  const write = deferred<AgentSkillSettingsView>();
  let skillReads = 0;
  let notifySettingsChanged: (() => void) | undefined;
  const rendered = await renderSettings({ destination: 'skills' }, async (command) => {
    if (command === 'agent_list_all_skills') return [localSkill('notes'), localSkill('other')];
    if (command === 'agent_get_skill_settings') {
      skillReads += 1;
      return skillReads === 1 ? { disabledSkills: [], sourceBindings: [] } : refresh.promise;
    }
    if (command === 'agent_update_skill_settings') return write.promise;
    return fixtureCommand(command);
  }, {
    onConfigurationChanged: (_domain: string, listener: () => void) => {
      notifySettingsChanged = listener;
      return () => undefined;
    },
  });
  const notes = switchFor(rendered.document, 'Toggle notes');

  await act(async () => {
    notifySettingsChanged?.();
    notes.click();
    await settle();
  });
  write.resolve({ disabledSkills: ['notes'], sourceBindings: [] });
  await act(async () => { await settle(); });
  refresh.resolve({ disabledSkills: [], sourceBindings: [] });
  await act(async () => { await settle(); });

  expect(notes.getAttribute('aria-checked')).toBe('false');
});

test('a refresh during a pending Skill write cannot erase queued toggles', async () => {
  const refresh = deferred<AgentSkillSettingsView>();
  const writes = [deferred<AgentSkillSettingsView>(), deferred<AgentSkillSettingsView>()];
  const calls: Array<Record<string, unknown> | undefined> = [];
  let skillReads = 0;
  let notifySettingsChanged: (() => void) | undefined;
  const rendered = await renderSettings({ destination: 'skills' }, async (command, args) => {
    if (command === 'agent_list_all_skills') return [localSkill('notes'), localSkill('other')];
    if (command === 'agent_get_skill_settings') {
      skillReads += 1;
      return skillReads === 1 ? { disabledSkills: [], sourceBindings: [] } : refresh.promise;
    }
    if (command === 'agent_update_skill_settings') {
      const index = calls.push(args) - 1;
      return writes[index]!.promise;
    }
    return fixtureCommand(command);
  }, {
    onConfigurationChanged: (_domain: string, listener: () => void) => {
      notifySettingsChanged = listener;
      return () => undefined;
    },
  });
  const notes = switchFor(rendered.document, 'Toggle notes');
  const other = switchFor(rendered.document, 'Toggle other');

  await act(async () => {
    notes.click();
    other.click();
    notifySettingsChanged?.();
    await settle();
  });
  refresh.resolve({ disabledSkills: [], sourceBindings: [] });
  await act(async () => { await settle(); });
  writes[0]!.resolve({ disabledSkills: ['notes'], sourceBindings: [] });
  await act(async () => { await settle(); });

  expect(calls.map((args) => (args?.settings as { disabledSkills?: string[] }).disabledSkills))
    .toEqual([['notes'], ['notes', 'other']]);
  writes[1]!.resolve({ disabledSkills: ['notes', 'other'], sourceBindings: [] });
  await act(async () => { await settle(); });
  expect(notes.getAttribute('aria-checked')).toBe('false');
  expect(other.getAttribute('aria-checked')).toBe('false');
});

test('a failed concurrent capability removal restores only its own rule', async () => {
  const first = deferred<AgentCapabilitySettingsView>();
  const second = deferred<AgentCapabilitySettingsView>();
  const rendered = await renderSettings({ destination: 'access' }, async (command, args) => {
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

test('Access refresh events cannot resurrect another optimistic removal while writes are in flight', async () => {
  const writes = [deferred<AgentCapabilitySettingsView>(), deferred<AgentCapabilitySettingsView>()];
  let refresh: (() => void) | undefined;
  let reads = 0;
  let blocks = ['Command(first)', 'Command(second)'];
  const rendered = await renderSettings({ destination: 'access' }, async (command, args) => {
    if (command === 'agent_get_capability_settings') { reads += 1; return { blocks, diagnostics: [] }; }
    if (command === 'agent_apply_capability_settings_patch') {
      return writes[(args?.patch as { removeBlocks: string[] }).removeBlocks[0] === 'Command(first)' ? 0 : 1]!.promise;
    }
    return fixtureCommand(command);
  }, { onConfigurationChanged: (_domain: string, listener: () => void) => { refresh = listener; return () => undefined; } });
  const buttons = [...rendered.document.querySelectorAll<HTMLButtonElement>('.settings-security-section button')]
    .filter((button) => button.textContent?.trim() === 'Remove');
  await act(async () => { buttons[0]!.click(); buttons[1]!.click(); await settle(); });
  await act(async () => {
    blocks = ['Command(second)']; refresh?.(); writes[0]!.resolve({ blocks, diagnostics: [] }); await settle();
  });
  expect(reads).toBe(1);
  expect(rendered.document.body.textContent).not.toContain('Command(second)');
  await act(async () => {
    blocks = []; refresh?.(); writes[1]!.resolve({ blocks, diagnostics: [] }); await settle();
  });
  expect(reads).toBe(2);
  expect(rendered.document.body.textContent).not.toContain('Command(second)');
});

test('Preview settings contains data maintenance without global translation controls', async () => {
  const rendered = await renderSettings(
    { destination: 'data' },
    async (command) => fixtureCommand(command),
    previewOperationsBridge().bridge,
  );
  const section = rendered.document.querySelector('.agent-settings-section')!;
  expect(section.textContent).toContain('Translation data');
  expect(section.textContent).toContain('Website data');
  expect(section.querySelector('[role="switch"]')).toBeNull();
  expect(section.querySelector('select')).toBeNull();
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
      onConfigurationChanged: () => () => undefined,
      reportRendererError: (report: unknown) => { reports.push(report); },
      ...linOverrides,
    },
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(target.destination === 'models' ? <ModelsManager /> : target.destination === 'skills' ? <SkillsManager active toolbarTarget={null} /> : target.destination === 'access' ? <AccessManager /> : <PreviewDataPanel />);
    await settle();
  });
  const rendered = { cleanup: () => act(() => root.unmount()), document, reports };
  mounted.push(rendered);
  return rendered;
}

async function fixtureCommand(command: string): Promise<unknown> {
  if (command === 'agent_get_provider_settings') return providerSettings(true);
  if (command === 'agent_get_skill_settings') return { disabledSkills: [], sourceBindings: [] } satisfies AgentSkillSettingsView;
  if (command === 'agent_get_capability_settings') return { blocks: [], diagnostics: [] };
  if (command === 'agent_list_all_skills') return [];
  if (command === 'agent_managed_skill_list' || command === 'agent_managed_skill_check_updates') {
    return { ok: true, value: [] };
  }
  if (command === 'agent_managed_skill_catalog') {
    return { ok: true, value: { status: 'fresh', entries: [] } };
  }
  if (command === 'memory_inspect') {
    return {
      operation: 'status',
      status: {
        featureMode: 'disabled',
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
    imageGeneration: {},
  };
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

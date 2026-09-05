import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  AgentDelegationSettingsInput,
  AgentProviderSettingsView,
} from '../../src/renderer/api/types';
import { SettingsDelegationGroup } from '../../src/renderer/ui/agent/SettingsDelegationGroup';

const mounted: Array<() => void> = [];
const GLOBAL_KEYS = ['document', 'Event', 'HTMLElement', 'Node', 'window'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('SettingsDelegationGroup', () => {
  test('shows only the experiment switch while delegation is off', async () => {
    const calls: AgentDelegationSettingsInput[] = [];
    const { document, click } = await render(settings(false), async (input) => { calls.push(input); });

    expect(document.querySelector('[aria-label="Model"]')).toBeNull();
    await click(document.querySelector('[aria-label="Experimental delegation"]'));
    expect(calls).toEqual([{ enabled: true }]);
  });

  test('shows internal policy and submits exact model and limit patches', async () => {
    const calls: AgentDelegationSettingsInput[] = [];
    const rendered = await render(settings(true), async (input) => { calls.push(input); });
    const model = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Model"]');
    const globalLimit = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Running globally"]');
    expect(model).not.toBeNull();
    expect(globalLimit).not.toBeNull();

    await rendered.change(model, 'openai/gpt-test');
    await rendered.change(globalLimit, '16');

    expect(calls).toEqual([
      { runners: { internal: { model: 'openai/gpt-test' } } },
      { maxConcurrentGlobal: 16 },
    ]);
  });

  test('keeps an unavailable explicit model visible as not ready', async () => {
    const configured = settings(true);
    configured.agent.delegation.runners.internal!.model = 'openai/missing';
    configured.agent.delegation.runners.internal!.effort = 'xhigh';
    const { document } = await render(configured, async () => undefined);

    expect(document.body.textContent).toContain('The selected model is unavailable.');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Model"]')?.value).toBe('openai/missing');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Reasoning"]')?.textContent).toContain('xhigh - Unavailable');
  });

  test('serializes two changes issued before React can disable the controls', async () => {
    const calls: AgentDelegationSettingsInput[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const rendered = await render(settings(true), async (input) => {
      calls.push(input);
      if (calls.length === 1) await firstPending;
    });
    const model = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Model"]');
    const globalLimit = rendered.document.querySelector<HTMLSelectElement>('[aria-label="Running globally"]');
    if (!model || !globalLimit) throw new Error('Missing policy controls');

    await act(async () => {
      Object.defineProperty(model, 'value', { configurable: true, value: 'openai/gpt-test' });
      model.dispatchEvent(new Event('change', { bubbles: true }));
      Object.defineProperty(globalLimit, 'value', { configurable: true, value: '16' });
      globalLimit.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(calls).toEqual([{ runners: { internal: { model: 'openai/gpt-test' } } }]);

    releaseFirst?.();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls).toEqual([
      { runners: { internal: { model: 'openai/gpt-test' } } },
      { maxConcurrentGlobal: 16 },
    ]);
  });
});

function settings(enabled: boolean): AgentProviderSettingsView {
  return {
    activeProviderId: 'openai',
    providers: [{
      providerId: 'openai',
      enabled: true,
      hasApiKey: true,
      auth: { authKind: 'api-key', credentialed: true },
    }],
    availableProviders: [{
      providerId: 'openai',
      authKind: 'api-key',
      hasEnvApiKey: false,
      envKeyNames: ['OPENAI_API_KEY'],
      models: [{
        id: 'gpt-test',
        name: 'GPT Test',
        reasoning: true,
        supportedThinkingLevels: ['medium', 'high'],
        contextWindow: 128_000,
        maxTokens: 16_000,
      }],
    }],
    agent: {
      additionalSkillDirectories: [],
      providerTimeoutMs: null,
      providerMaxRetries: null,
      providerMaxRetryDelayMs: 60_000,
      providerCacheRetention: 'short',
      disabledSkills: [],
      delegation: {
        enabled,
        defaultRunnerId: 'internal',
        maxConcurrentGlobal: 8,
        maxConcurrentThread: 4,
        maxQueuedGlobal: 32,
        maxQueuedThread: 8,
        runners: {
          internal: {
            enabled: true,
            model: null,
            effort: null,
            maximumAccess: 'workspace-write',
            timeoutMs: 3_600_000,
            maxConcurrent: 4,
            pool: 'agent-provider',
            maxConcurrentPool: 4,
          },
        },
      },
    },
    imageGeneration: {},
  };
}

async function render(
  settingsView: AgentProviderSettingsView,
  onChange: (input: AgentDelegationSettingsInput) => Promise<void>,
) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  await act(async () => {
    root.render(<SettingsDelegationGroup onChange={onChange} settings={settingsView} />);
  });
  mounted.push(() => { act(() => root.unmount()); });
  return {
    document,
    click: async (element: Element | null) => {
      if (!element) throw new Error('Missing click target');
      await act(async () => { element.dispatchEvent(new window.Event('click', { bubbles: true })); });
    },
    change: async (element: HTMLSelectElement | null, value: string) => {
      if (!element) throw new Error('Missing select target');
      Object.defineProperty(element, 'value', { configurable: true, value });
      await act(async () => {
        element.dispatchEvent(new window.Event('change', { bubbles: true, cancelable: true }));
      });
    },
  };
}

function installDomGlobals(window: unknown): void {
  const source = window as Record<string, unknown>;
  savedGlobals = [
    ...GLOBAL_KEYS.map((key): [string, PropertyDescriptor | undefined] => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]
    )),
    ['IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')],
  ];
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: source[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
}

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AgentComposerModelControl } from '../../src/renderer/ui/agent/AgentComposerModelControl';
import type { AgentProviderSettingsView } from '../../src/renderer/api/types';

interface Rendered {
  cleanup: () => void;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(async () => {
  while (mounted.length) mounted.pop()?.cleanup();
  // Frames are synchronous here (see renderComponent's requestAnimationFrame stub), but
  // drain any stray macrotask while the linkedom globals are still installed so no late
  // work runs after `window` is removed below.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

function renderComponent(element: ReactNode): Rendered {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  // linkedom has no requestAnimationFrame, so the anchored-overlay hooks fall back to a
  // deferred `setTimeout` whose reposition `setStyle` fires AFTER the render's act() block
  // ("An update … was not wrapped in act(...)"). A synchronous frame runs that reposition
  // inline, inside act — deterministic and warning-free (the deps exclude `style`, so the
  // extra synchronous `update()` cannot loop). Set on the per-test window (discarded after).
  (window as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame = (cb) => { cb(0); return 0; };
  (window as unknown as { cancelAnimationFrame: (handle: number) => void })
    .cancelAnimationFrame = () => { /* synchronous frame: nothing to cancel */ };
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const container = window.document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => { root.render(element); });
  const rendered: Rendered = { cleanup: () => { act(() => root.unmount()); }, container, document: window.document, window };
  mounted.push(rendered);
  return rendered;
}

function chip(rendered: Rendered): HTMLButtonElement {
  const found = rendered.document.querySelector<HTMLButtonElement>('button[aria-label="Model and reasoning"]');
  if (!found) throw new Error('Missing model chip');
  return found;
}

async function click(rendered: Rendered, el: Element) {
  await act(async () => {
    el.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function modelItem(rendered: Rendered, name: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    .find((el) => el.querySelector('.agent-composer-model-item-label')?.textContent?.trim() === name);
  if (!found) throw new Error(`Missing model item: ${name}`);
  return found;
}

function triggerRow(rendered: Rendered, label: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('.agent-composer-model-row'))
    .find((el) => el.querySelector('.agent-composer-model-item-label')?.textContent?.trim() === label);
  if (!found) throw new Error(`Missing trigger row: ${label}`);
  return found;
}

function settings(): AgentProviderSettingsView {
  return {
    activeProviderId: 'openai',
    providers: [
      { providerId: 'openai', enabled: true, hasApiKey: true, auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true } },
    ],
    availableProviders: [
      {
        providerId: 'openai',
        authKind: 'api-key',
        hasEnvApiKey: false,
        envKeyNames: [],
        models: [
          { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, supportedThinkingLevels: ['off', 'low', 'medium', 'high'], contextWindow: 0, maxTokens: 0 },
        ],
      },
    ],
    agent: {} as AgentProviderSettingsView['agent'],
    imageGeneration: {},
  };
}

function multiProviderSettings(): AgentProviderSettingsView {
  const credential = { authKind: 'api-key', credentialed: true, hasStoredKey: true } as const;
  const levels: ReadonlyArray<'off' | 'low' | 'medium' | 'high'> = ['off', 'low', 'medium', 'high'];
  return {
    activeProviderId: 'openai',
    providers: [
      { providerId: 'openai', enabled: true, hasApiKey: true, auth: credential },
      { providerId: 'anthropic', enabled: true, hasApiKey: true, auth: credential },
    ],
    availableProviders: [
      {
        providerId: 'openai',
        authKind: 'api-key',
        hasEnvApiKey: false,
        envKeyNames: [],
        models: [
          { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, supportedThinkingLevels: [...levels], contextWindow: 0, maxTokens: 0 },
          { id: 'gpt-5.3', name: 'GPT-5.3', reasoning: true, supportedThinkingLevels: [...levels], contextWindow: 0, maxTokens: 0 },
        ],
      },
      {
        providerId: 'anthropic',
        authKind: 'api-key',
        hasEnvApiKey: false,
        envKeyNames: [],
        models: [
          { id: 'claude-sonnet', name: 'Claude Sonnet', reasoning: true, supportedThinkingLevels: [...levels], contextWindow: 0, maxTokens: 0 },
        ],
      },
    ],
    agent: {} as AgentProviderSettingsView['agent'],
    imageGeneration: {},
  };
}

function manyModelSettings(count: number): AgentProviderSettingsView {
  const levels: ReadonlyArray<'off' | 'low' | 'medium' | 'high'> = ['off', 'low', 'medium', 'high'];
  return {
    activeProviderId: 'openai',
    providers: [
      { providerId: 'openai', enabled: true, hasApiKey: true, auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true } },
    ],
    availableProviders: [
      {
        providerId: 'openai',
        authKind: 'api-key',
        hasEnvApiKey: false,
        envKeyNames: [],
        models: Array.from({ length: count }, (_unused, index) => ({
          id: `m${index + 1}`,
          name: `M${index + 1}`,
          reasoning: true,
          supportedThinkingLevels: [...levels],
          contextWindow: 0,
          maxTokens: 0,
        })),
      },
    ],
    agent: {} as AgentProviderSettingsView['agent'],
    imageGeneration: {},
  };
}

function NOOP() { /* no-op */ }

describe('AgentComposerModelControl', () => {
  test('the chip shows the catalog model name + reasoning, and hides the popover until opened', () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="openai/gpt-5.4" effort="high" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    // The chip resolves the explicit model to its catalog DISPLAY name, not the raw id.
    expect(rendered.container.querySelector('.agent-composer-model-name')?.textContent).toBe('GPT-5.4');
    expect(rendered.container.querySelector('.agent-composer-reasoning-chip')?.textContent).toBe('High');
    // Closed by default — no selector, and aria-expanded false.
    expect(chip(rendered).getAttribute('aria-expanded')).toBe('false');
    expect(rendered.document.querySelector('.agent-composer-model-popover')).toBeNull();
  });

  test('an inherit model resolves to the active provider first-ranked model name (no vague "Default model")', () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="inherit" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    // inherit shows the model the runtime actually runs (openai's first-ranked), not a placeholder.
    expect(rendered.container.querySelector('.agent-composer-model-name')?.textContent).toBe('GPT-5.4');
    expect(rendered.container.querySelector('.agent-composer-reasoning-chip')).toBeNull();
  });

  test('falls back to the default-model label only when no model can be resolved', () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={null} model="" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(rendered.container.querySelector('.agent-composer-model-name')?.textContent).toBe('Default model');
  });

  test('the Reasoning row opens a submenu (hint + Off level + Default badge); picking a level emits it', async () => {
    let savedEffort = '';
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="openai/gpt-5.4" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={(value) => { savedEffort = value; }}
      />,
    );
    await click(rendered, chip(rendered));
    // The main menu only shows the result; the levels live in a submenu.
    expect(rendered.document.querySelector('.agent-composer-model-submenu')).toBeNull();
    await click(rendered, triggerRow(rendered, 'Reasoning'));
    expect(rendered.document.querySelector('.agent-composer-model-section-hint')?.textContent).toContain('Higher effort');
    // "Off" is a regular level (no separate Thinking toggle).
    expect(modelItem(rendered, 'Off')).toBeTruthy();
    // The level inherit resolves to (medium, for off/low/medium/high) carries the badge.
    expect(modelItem(rendered, 'Medium').querySelector('.agent-composer-model-badge')?.textContent).toBe('Default');
    expect(modelItem(rendered, 'High').querySelector('.agent-composer-model-badge')).toBeNull();
    await click(rendered, modelItem(rendered, 'High'));
    expect(savedEffort).toBe('high');
  });

  test('xhigh uses the selected model provider label instead of a fixed Max label', async () => {
    const view = settings();
    view.availableProviders[0]!.models = [
      {
        id: 'gpt-codex',
        name: 'GPT Codex',
        reasoning: true,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
        thinkingLevelLabels: { xhigh: 'xhigh' },
        contextWindow: 0,
        maxTokens: 0,
      },
    ];
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={view} model="openai/gpt-codex" effort="xhigh" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(rendered.container.querySelector('.agent-composer-reasoning-chip')?.textContent).toBe('XHigh');
    await click(rendered, chip(rendered));
    expect(triggerRow(rendered, 'Reasoning').querySelector('.agent-composer-model-item-meta')?.textContent).toBe('XHigh');
    await click(rendered, triggerRow(rendered, 'Reasoning'));
    expect(modelItem(rendered, 'XHigh')).toBeTruthy();
    expect(() => modelItem(rendered, 'Max')).toThrow();
  });

  test('the reasoning submenu only shows the selected model levels and labels each mapped level', async () => {
    const view = settings();
    view.availableProviders[0]!.models = [
      {
        id: 'gemini-thinking',
        name: 'Gemini Thinking',
        reasoning: true,
        supportedThinkingLevels: ['low', 'high'],
        thinkingLevelLabels: { low: 'LOW', high: 'HIGH' },
        contextWindow: 0,
        maxTokens: 0,
      },
    ];
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={view} model="openai/gemini-thinking" effort="high" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(rendered.container.querySelector('.agent-composer-reasoning-chip')?.textContent).toBe('High');
    await click(rendered, chip(rendered));
    expect(triggerRow(rendered, 'Reasoning').querySelector('.agent-composer-model-item-meta')?.textContent).toBe('High');
    await click(rendered, triggerRow(rendered, 'Reasoning'));
    expect(modelItem(rendered, 'Low')).toBeTruthy();
    expect(modelItem(rendered, 'High')).toBeTruthy();
    expect(() => modelItem(rendered, 'Medium')).toThrow();
  });

  test('the main menu shows the current model as a single row; the submenu lists all models', async () => {
    let saved = '';
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={multiProviderSettings()} model="" effort="" disabled={false}
        onModelChange={(value) => { saved = value; }} onEffortChange={NOOP}
      />,
    );
    await click(rendered, chip(rendered));
    // Main menu: a single model row for the current selection (active provider's first-ranked).
    expect(triggerRow(rendered, 'GPT-5.4')).toBeTruthy();
    // The full list (incl. the current one) is hidden until the model row opens the submenu.
    expect(() => modelItem(rendered, 'GPT-5.3')).toThrow();
    await click(rendered, triggerRow(rendered, 'GPT-5.4'));
    const submenu = rendered.document.querySelector('.agent-composer-model-submenu');
    expect(submenu).not.toBeNull();
    // Multiple providers → grouped by provider header; every model is listed.
    const headers = Array.from(submenu!.querySelectorAll('.agent-composer-model-group-label')).map((el) => el.textContent);
    expect(headers).toEqual(['openai', 'anthropic']);
    expect(modelItem(rendered, 'GPT-5.3')).toBeTruthy();
    await click(rendered, modelItem(rendered, 'Claude Sonnet'));
    expect(saved).toBe('anthropic/claude-sonnet');
  });

  test('disabled providers stay out of the composer model menu even when credentialed', async () => {
    const view = multiProviderSettings();
    view.providers = view.providers.map((provider) => (
      provider.providerId === 'anthropic' ? { ...provider, enabled: false } : provider
    ));
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={view} model="anthropic/claude-sonnet" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    // A stale saved model from a disabled provider resolves back to the runnable
    // provider's default, and the disabled provider is not offered in the submenu.
    expect(rendered.container.querySelector('.agent-composer-model-name')?.textContent).toBe('GPT-5.4');
    await click(rendered, chip(rendered));
    await click(rendered, triggerRow(rendered, 'GPT-5.4'));
    expect(modelItem(rendered, 'GPT-5.3')).toBeTruthy();
    expect(() => modelItem(rendered, 'Claude Sonnet')).toThrow();
  });

  test('enabled CC Switch models appear in the composer model menu', async () => {
    const view = multiProviderSettings();
    view.providers.push({
      providerId: 'cc-switch',
      baseUrl: 'http://127.0.0.1:15721/v1',
      enabled: true,
      hasApiKey: false,
      auth: { authKind: 'api-key', credentialed: true, hasStoredKey: false },
    });
    view.availableProviders.push({
      providerId: 'cc-switch',
      authKind: 'api-key',
      credentialed: true,
      detected: true,
      hasEnvApiKey: false,
      envKeyNames: [],
      defaultBaseUrl: 'http://127.0.0.1:15721/v1',
      models: [
        { id: 'gpt-5.4', name: 'Current routed model', reasoning: true, supportedThinkingLevels: ['off', 'low', 'medium', 'high'], contextWindow: 0, maxTokens: 0 },
      ],
    });
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={view} model="" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    await click(rendered, chip(rendered));
    await click(rendered, triggerRow(rendered, 'GPT-5.4'));
    expect(modelItem(rendered, 'Current routed model')).toBeTruthy();
  });

  test('a provider with many models shows the recent ones and a Show all expander', async () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={manyModelSettings(8)} model="" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    await click(rendered, chip(rendered));
    await click(rendered, triggerRow(rendered, 'M1'));
    // Recent (first 6) shown; the older tail is hidden behind the expander.
    expect(modelItem(rendered, 'M6')).toBeTruthy();
    expect(() => modelItem(rendered, 'M7')).toThrow();
    const expander = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('.agent-composer-model-expander'))
      .find((el) => el.textContent?.includes('Show all'));
    expect(expander?.textContent).toContain('Show all (8)');
    await click(rendered, expander!);
    // Expanded → the whole catalog is reachable.
    expect(modelItem(rendered, 'M7')).toBeTruthy();
    expect(modelItem(rendered, 'M8')).toBeTruthy();
  });

  test('a saved model absent from the catalog is still shown/checked, and hides the Reasoning row', async () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="openai/legacy-model" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    await click(rendered, chip(rendered));
    // No declared levels for an unknown model → no Reasoning row (so no unsupported
    // effort can be offered/persisted); only the model row remains.
    expect(() => triggerRow(rendered, 'Reasoning')).toThrow();
    await click(rendered, triggerRow(rendered, 'legacy-model'));
    // The out-of-catalog model is surfaced in its provider group and checked.
    const item = modelItem(rendered, 'legacy-model');
    expect(item.getAttribute('aria-checked')).toBe('true');
  });

  test('the chip is disabled when there is no provider settings', () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={null} model="" effort="" disabled
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(chip(rendered).hasAttribute('disabled')).toBe(true);
  });
});

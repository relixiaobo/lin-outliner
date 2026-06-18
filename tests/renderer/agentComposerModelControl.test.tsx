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

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
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

async function changeSelect(rendered: Rendered, label: string, value: string) {
  const el = rendered.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!el) throw new Error(`Missing select: ${label}`);
  const target = Array.from(el.querySelectorAll('option')).find((option) => (option.getAttribute('value') ?? '') === value);
  if (!target) throw new Error(`Option not found in ${label}: ${value}`);
  await act(async () => {
    (target as unknown as { selected: boolean }).selected = true;
    el.dispatchEvent(new rendered.window.Event('change', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
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
  };
}

function NOOP() { /* no-op */ }

describe('AgentComposerModelControl', () => {
  test('the chip shows the model name (last path segment) + reasoning, and hides the popover until opened', () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="openai/gpt-5.4" effort="high" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(rendered.container.querySelector('.agent-composer-model-name')?.textContent).toBe('gpt-5.4');
    expect(rendered.container.querySelector('.agent-composer-reasoning-chip')?.textContent).toBe('High');
    // Closed by default — no selector, and aria-expanded false.
    expect(chip(rendered).getAttribute('aria-expanded')).toBe('false');
    expect(rendered.document.querySelector('.agent-composer-model-popover')).toBeNull();
  });

  test('an inherit/empty model shows the default-model label and no reasoning chip', () => {
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="inherit" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(rendered.container.querySelector('.agent-composer-model-name')?.textContent).toBe('Default model');
    expect(rendered.container.querySelector('.agent-composer-reasoning-chip')).toBeNull();
  });

  test('clicking the chip opens the selector popover; picking a model emits onModelChange', async () => {
    let saved = '';
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="" effort="" disabled={false}
        onModelChange={(value) => { saved = value; }} onEffortChange={NOOP}
      />,
    );
    expect(rendered.document.querySelector('.agent-composer-model-popover')).toBeNull();
    await click(rendered, chip(rendered));
    expect(rendered.document.querySelector('.agent-composer-model-popover')).not.toBeNull();
    expect(chip(rendered).getAttribute('aria-expanded')).toBe('true');
    // Choosing the provider emits its first-ranked model as a provider-qualified id.
    await changeSelect(rendered, 'Provider', 'openai');
    expect(saved).toBe('openai/gpt-5.4');
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

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
  // The anchored overlay schedules a deferred frame (rAF, or a setTimeout fallback)
  // to reposition; drain pending macrotasks while the linkedom globals are still
  // installed so that work never runs after `window` is removed below.
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
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('.agent-composer-model-item'))
    .find((el) => el.textContent?.trim() === name);
  if (!found) throw new Error(`Missing model item: ${name}`);
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

  test('clicking the chip opens the model menu; picking a model emits a provider-qualified id', async () => {
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
    // The active provider's models list directly; choosing one emits its qualified id.
    await click(rendered, modelItem(rendered, 'GPT-5.4'));
    expect(saved).toBe('openai/gpt-5.4');
  });

  test('the reasoning control emits the chosen level', async () => {
    let savedEffort = '';
    const rendered = renderComponent(
      <AgentComposerModelControl
        settings={settings()} model="openai/gpt-5.4" effort="" disabled={false}
        onModelChange={NOOP} onEffortChange={(value) => { savedEffort = value; }}
      />,
    );
    await click(rendered, chip(rendered));
    const high = rendered.document.querySelector<HTMLButtonElement>('.agent-composer-model-reasoning-control [role="radio"][aria-checked="false"]:last-child');
    expect(high).not.toBeNull();
    await click(rendered, high!);
    expect(savedEffort).toBe('high');
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

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AgentModelEffortSelector } from '../../src/renderer/ui/agent/AgentModelEffortSelector';
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

function select(rendered: Rendered, label: string): HTMLSelectElement {
  const found = rendered.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing select: ${label}`);
  return found;
}

async function changeSelect(rendered: Rendered, label: string, value: string) {
  const el = select(rendered, label);
  const target = Array.from(el.querySelectorAll('option'))
    .find((option) => (option.getAttribute('value') ?? '') === value);
  if (!target) throw new Error(`Option not found in ${label}: ${value}`);
  await act(async () => {
    // linkedom's `select.value` is getter-only (it reads `option[selected]`); set the
    // target option selected — its setter auto-clears the previously-selected option —
    // so `select.value`, which React's onChange reads, reflects the new choice.
    (target as unknown as { selected: boolean }).selected = true;
    el.dispatchEvent(new rendered.window.Event('change', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function optionValues(el: HTMLSelectElement): string[] {
  return Array.from(el.querySelectorAll('option')).map((option) => option.getAttribute('value') ?? '');
}

function settings(): AgentProviderSettingsView {
  return {
    activeProviderId: 'openai',
    providers: [
      { providerId: 'openai', enabled: true, hasApiKey: true, auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true } },
      { providerId: 'amazon-bedrock', enabled: true, hasApiKey: false, auth: { authKind: 'managed', credentialed: true } },
    ],
    availableProviders: [
      {
        providerId: 'openai',
        authKind: 'api-key',
        hasEnvApiKey: false,
        envKeyNames: [],
        models: [
          { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, supportedThinkingLevels: ['off', 'low', 'medium', 'high'], contextWindow: 0, maxTokens: 0 },
          { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', reasoning: false, supportedThinkingLevels: ['off'], contextWindow: 0, maxTokens: 0 },
        ],
      },
      {
        providerId: 'amazon-bedrock',
        authKind: 'managed',
        hasEnvApiKey: false,
        envKeyNames: [],
        models: [
          { id: 'amazon.nova-lite-v1:0', name: 'Nova Lite', reasoning: false, supportedThinkingLevels: ['off'], contextWindow: 0, maxTokens: 0 },
        ],
      },
    ],
    agent: {} as AgentProviderSettingsView['agent'],
  };
}

const LABELS = { providerLabel: 'Provider', modelLabel: 'Model', effortLabel: 'Effort', inheritLabel: 'Inherit' };

function NOOP() { /* no-op */ }

describe('AgentModelEffortSelector', () => {
  test('with no provider chosen, only the Provider control renders (no Model control yet)', () => {
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={settings()} model="" effort="" disabled={false}
        {...LABELS} onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    expect(rendered.document.querySelector('select[aria-label="Provider"]')).not.toBeNull();
    expect(rendered.document.querySelector('select[aria-label="Model"]')).toBeNull();
  });

  test('selecting a provider emits a provider-qualified model id (first ranked model)', async () => {
    let saved = '';
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={settings()} model="" effort="" disabled={false}
        {...LABELS} onModelChange={(v) => { saved = v; }} onEffortChange={NOOP}
      />,
    );
    await changeSelect(rendered, 'Provider', 'openai');
    expect(saved).toBe('openai/gpt-5.4');
  });

  test('the effort options derive from the selected model and emit a canonical level', async () => {
    let savedEffort = '';
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={settings()} model="openai/gpt-5.4" effort="" disabled={false}
        {...LABELS} onModelChange={NOOP} onEffortChange={(v) => { savedEffort = v; }}
      />,
    );
    // gpt-5.4 supports off/low/medium/high (plus the inherit option).
    expect(optionValues(select(rendered, 'Effort')).sort()).toEqual(['', 'high', 'low', 'medium', 'off']);
    await changeSelect(rendered, 'Effort', 'high');
    expect(savedEffort).toBe('high');
  });

  test('a bare colon-bearing Bedrock model id is NOT mis-split into a phantom provider', () => {
    const view = settings();
    view.activeProviderId = 'amazon-bedrock';
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={view} model="amazon.nova-lite-v1:0" effort="" disabled={false}
        {...LABELS} onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    // The phantom 'amazon.nova-lite-v1' provider must NOT be a provider option…
    expect(optionValues(select(rendered, 'Provider'))).not.toContain('amazon.nova-lite-v1');
    // …and the real model id is preserved as a model option under amazon-bedrock.
    expect(optionValues(select(rendered, 'Model'))).toContain('amazon.nova-lite-v1:0');
  });

  test('switching to a model that lacks the saved effort clears the effort (no silent divergence)', async () => {
    let savedModel = '';
    let savedEffort = 'unchanged';
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={settings()} model="openai/gpt-5.4" effort="high" disabled={false}
        {...LABELS} onModelChange={(v) => { savedModel = v; }} onEffortChange={(v) => { savedEffort = v; }}
      />,
    );
    // gpt-5.4-mini supports only 'off' — the stored 'high' must be cleared to inherit.
    await changeSelect(rendered, 'Model', 'gpt-5.4-mini');
    expect(savedModel).toBe('openai/gpt-5.4-mini');
    expect(savedEffort).toBe('');
  });

  test('selecting a custom (no-catalog) provider keeps it selected and shows the free-text model input', async () => {
    const view = settings();
    // A configured, credentialed connection with no catalog entry — a custom endpoint.
    view.providers.push({
      providerId: 'my-proxy',
      enabled: true,
      hasApiKey: true,
      auth: { authKind: 'api-key', credentialed: true, hasStoredKey: true },
    });
    let savedModel = 'sentinel';
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={view} model="" effort="" disabled={false}
        {...LABELS} onModelChange={(v) => { savedModel = v; }} onEffortChange={NOOP}
      />,
    );
    await changeSelect(rendered, 'Provider', 'my-proxy');
    // The provider stays selected (does not collapse back to Inherit), so the model
    // field is reachable as a free-text input rather than a catalog dropdown.
    expect(rendered.document.querySelector('input[aria-label="Model"]')).not.toBeNull();
    expect(rendered.document.querySelector('select[aria-label="Model"]')).toBeNull();
    // No model id is emitted yet — it is empty until the user types one.
    expect(savedModel).toBe('');
  });

  test('a saved effort the model no longer supports is reconciled to inherit on mount', () => {
    let savedEffort = 'unchanged';
    renderComponent(
      <AgentModelEffortSelector
        settings={settings()} model="openai/gpt-5.4-mini" effort="high" disabled={false}
        {...LABELS} onModelChange={NOOP} onEffortChange={(v) => { savedEffort = v; }}
      />,
    );
    // gpt-5.4-mini supports only 'off'; the stored 'high' is corrected to inherit at
    // mount, so Save can never persist a hidden, unsupported effort.
    expect(savedEffort).toBe('');
  });

  test('a saved model the catalog no longer lists still renders as a selectable option', () => {
    const rendered = renderComponent(
      <AgentModelEffortSelector
        settings={settings()} model="openai/ancient-model" effort="" disabled={false}
        {...LABELS} onModelChange={NOOP} onEffortChange={NOOP}
      />,
    );
    // The removed model id is surfaced (so the <select> shows it, not a misleading
    // first catalog option), alongside the current catalog models.
    expect(optionValues(select(rendered, 'Model'))).toContain('ancient-model');
  });
});

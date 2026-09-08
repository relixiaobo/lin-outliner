import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { CONFIGURABLE_SHORTCUTS, type KeybindingsUpdateInput, type KeybindingsView } from '../../src/core/keybindings';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { ShortcutManager } from '../../src/renderer/ui/agent/ShortcutManager';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window & typeof globalThis;
  updates: KeybindingsUpdateInput[];
  opened: () => number;
  emit: (next: KeybindingsView) => Promise<void>;
}
const mounted: Rendered[] = [];
afterEach(() => { while (mounted.length) mounted.pop()?.cleanup(); });

function view(status: KeybindingsView['source']['status'] = 'accepted'): KeybindingsView {
  return {
    source: {
      path: '/tmp/config/keybindings.jsonc',
      schemaPath: '/tmp/config/keybindings.schema.json',
      status,
      observedDigest: status === 'missing' ? null : '1234abcd',
      acceptedDigest: status === 'missing' ? null : '1234abcd',
      error: status === 'rejected' ? 'Invalid JSONC' : null,
    },
    entries: CONFIGURABLE_SHORTCUTS.map((definition) => ({
      id: definition.id,
      context: definition.context,
      desired: null,
      effective: definition.defaultBindings,
      defaults: definition.defaultBindings,
      status: 'default',
      error: null,
    })),
  };
}

async function renderManager(initial: KeybindingsView): Promise<Rendered> {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as {
    document: Document;
    window: Window & typeof globalThis;
  };
  const { document, window } = parsed;
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const updates: KeybindingsUpdateInput[] = [];
  let openCount = 0;
  let changed: ((next: KeybindingsView) => void) | null = null;
  (window as unknown as { lin: unknown }).lin = {
    initialLanguage: 'en',
    keybindings: {
      get: async () => initial,
      update: async (input: KeybindingsUpdateInput) => { updates.push(input); return initial; },
      openFile: async () => { openCount += 1; },
      onChanged: (listener: (next: KeybindingsView) => void) => {
        changed = listener;
        return () => { changed = null; };
      },
    },
  };
  const root: Root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(<I18nProvider><ShortcutManager onError={() => {}} onNotice={() => {}} /></I18nProvider>);
  });
  await act(async () => {});
  const rendered: Rendered = {
    cleanup: () => act(() => root.unmount()),
    document,
    window,
    updates,
    opened: () => openCount,
    emit: async (next) => { await act(async () => changed?.(next)); },
  };
  mounted.push(rendered);
  return rendered;
}

function withEntry(
  source: KeybindingsView,
  id: KeybindingsView['entries'][number]['id'],
  patch: Partial<KeybindingsView['entries'][number]>,
): KeybindingsView {
  return {
    ...source,
    entries: source.entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
  };
}

function keydown(window: Window & typeof globalThis, init: Record<string, unknown>): Event {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, ...init,
  })) Object.defineProperty(event, key, { configurable: true, value });
  return event;
}

describe('Shortcut Manager', () => {
  test('records a physical shortcut and writes it against the observed digest', async () => {
    const rendered = await renderManager(view());
    const change = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Change CommandOrControl+M"]',
    );
    expect(change).toBeDefined();
    await act(async () => change?.click());
    await act(async () => {
      rendered.window.dispatchEvent(keydown(rendered.window, { key: 'p', code: 'KeyP', metaKey: true }));
    });
    expect(rendered.updates).toContainEqual({
      id: 'global.open_agent_panel',
      value: 'CommandOrControl+P',
      observedDigest: '1234abcd',
    });
  });

  test('Escape cancels recording without a write', async () => {
    const rendered = await renderManager(view());
    const change = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Change CommandOrControl+M"]',
    );
    await act(async () => change?.click());
    await act(async () => {
      rendered.window.dispatchEvent(keydown(rendered.window, { key: 'Escape' }));
    });
    expect(rendered.updates).toEqual([]);
    expect(rendered.document.body.textContent).not.toContain('Press shortcut');
  });

  test('adds and removes alternate bindings', async () => {
    const rendered = await renderManager(view());
    const add = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Add an alternate for Open Agent panel"]',
    );
    await act(async () => add?.click());
    await act(async () => {
      rendered.window.dispatchEvent(keydown(rendered.window, { key: 'p', code: 'KeyP', ctrlKey: true }));
    });
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_agent_panel',
      value: ['CommandOrControl+M', 'Control+P'],
      observedDigest: '1234abcd',
    });

    const remove = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove CommandOrControl+M"]',
    );
    await act(async () => remove?.click());
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_agent_panel',
      value: false,
      observedDigest: '1234abcd',
    });
  });

  test('disables, resets one override, and resets all overrides', async () => {
    const custom = withEntry(view(), 'global.open_agent_panel', {
      desired: 'Control+P',
      effective: ['Control+P'],
      status: 'applied',
    });
    const rendered = await renderManager(custom);
    const enabled = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Enable Open Agent panel"]',
    );
    await act(async () => enabled?.click());
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_agent_panel',
      value: false,
      observedDigest: '1234abcd',
    });

    const reset = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Reset Open Agent panel"]',
    );
    await act(async () => reset?.click());
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_agent_panel',
      observedDigest: '1234abcd',
    });

    const resetAll = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Reset All'));
    await act(async () => resetAll?.click());
    expect(rendered.updates.at(-1)).toEqual({ resetAll: true, observedDigest: '1234abcd' });
  });

  test('follows external source changes', async () => {
    const rendered = await renderManager(view());
    await rendered.emit(withEntry(view(), 'global.open_agent_panel', {
      desired: 'Control+P',
      effective: ['Control+P'],
      status: 'applied',
    }));
    expect(rendered.document.querySelector('[aria-label="Change Control+P"]')).not.toBeNull();
  });

  test('opens the public source even when structured editing is unavailable', async () => {
    const rendered = await renderManager(view('rejected'));
    const open = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Open Keybindings File'));
    await act(async () => open?.click());
    expect(rendered.opened()).toBe(1);
  });

  test('rejected source remains openable but disables structured edits', async () => {
    const rendered = await renderManager(view('rejected'));
    expect(rendered.document.body.textContent).toContain('keybindings file is invalid');
    expect(rendered.document.querySelector<HTMLButtonElement>('[aria-label="Enable Global launcher"]')?.disabled).toBe(true);
    expect(Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Open Keybindings File'))?.disabled).toBe(false);
  });
});

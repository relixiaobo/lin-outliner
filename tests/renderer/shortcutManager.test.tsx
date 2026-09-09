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

async function renderManager(
  initial: KeybindingsView,
  failUpdate = false,
  readInitial: () => Promise<KeybindingsView> = async () => initial,
): Promise<Rendered> {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as {
    document: Document;
    window: Window & typeof globalThis;
  };
  const { document, window } = parsed;
  const globals = ['document', 'window', 'HTMLElement', 'Element', 'KeyboardEvent', 'MouseEvent', 'Event', 'Node',
    'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
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
      get: readInitial,
      update: async (input: KeybindingsUpdateInput) => { updates.push(input); if (failUpdate) throw new Error('Shortcut could not be saved'); return initial; },
      openFile: async () => { openCount += 1; },
      onChanged: (listener: (next: KeybindingsView) => void) => {
        changed = listener;
        return () => { changed = null; };
      },
    },
  };
  const root: Root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(<I18nProvider><ShortcutManager /></I18nProvider>);
  });
  await act(async () => {});
  const rendered: Rendered = {
    cleanup: () => {
      act(() => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
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
    await act(async () => change?.dispatchEvent(new rendered.window.Event('dblclick', { bubbles: true })));
    await act(async () => {
      rendered.document.querySelector('.settings-shortcut-key.is-recording')!.dispatchEvent(keydown(rendered.window, { key: 'p', code: 'KeyP', metaKey: true }));
    });
    expect(rendered.updates).toContainEqual({
      id: 'global.open_page_in_pane',
      value: 'CommandOrControl+P',
      observedDigest: '1234abcd',
    });
  });

  test('keeps a failed shortcut write beside the command being edited', async () => {
    const rendered = await renderManager(view(), true);
    const change = rendered.document.querySelector<HTMLButtonElement>('[aria-label="Change CommandOrControl+M"]')!;
    await act(async () => change.dispatchEvent(new rendered.window.Event('dblclick', { bubbles: true })));
    await act(async () => rendered.document.querySelector('.settings-shortcut-key.is-recording')!.dispatchEvent(
      keydown(rendered.window, { key: 'p', code: 'KeyP', metaKey: true }),
    ));
    expect(change.closest('.settings-shortcut-row')?.querySelector('[role="alert"]')?.textContent).toBe('Shortcut could not be saved');
    expect(rendered.document.querySelector('[data-shortcut-id="global.new_thread"] [role="alert"]') === null).toBe(true);
  });

  test('Escape cancels recording without a write', async () => {
    const rendered = await renderManager(view());
    const change = rendered.document.querySelector<HTMLButtonElement>(
      '[aria-label="Change CommandOrControl+M"]',
    );
    await act(async () => change?.dispatchEvent(new rendered.window.Event('dblclick', { bubbles: true })));
    await act(async () => {
      rendered.document.querySelector('.settings-shortcut-key.is-recording')!.dispatchEvent(keydown(rendered.window, { key: 'Escape' }));
    });
    expect(rendered.updates).toEqual([]);
    expect(rendered.document.querySelector('.settings-shortcut-key.is-recording')).toBeNull();
  });

  test('adds and removes alternate bindings', async () => {
    const rendered = await renderManager(view());
    await clickMenu(rendered, 'Open page in new pane actions', 'Add an alternate for Open page in new pane');
    await act(async () => {
      rendered.document.querySelector('.settings-shortcut-key.is-recording')!.dispatchEvent(keydown(rendered.window, { key: 'p', code: 'KeyP', ctrlKey: true }));
    });
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_page_in_pane',
      value: ['CommandOrControl+M', 'Control+P'],
      observedDigest: '1234abcd',
    });

    await clickMenu(rendered, 'Open page in new pane actions', 'Remove ⌘M');
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_page_in_pane',
      value: false,
      observedDigest: '1234abcd',
    });
  });

  test('disables, resets one override, and resets all overrides', async () => {
    const custom = withEntry(view(), 'global.open_page_in_pane', {
      desired: 'Control+P',
      effective: ['Control+P'],
      status: 'applied',
    });
    const rendered = await renderManager(custom);
    const key = rendered.document.querySelector<HTMLButtonElement>('[aria-label="Change Control+P"]')!;
    await act(async () => key.dispatchEvent(new rendered.window.Event('dblclick', { bubbles: true })));
    await act(async () => key.dispatchEvent(keydown(rendered.window, { key: 'Backspace' })));
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_page_in_pane',
      value: false,
      observedDigest: '1234abcd',
    });

    await clickMenu(rendered, 'Open page in new pane actions', 'Reset Open page in new pane');
    expect(rendered.updates.at(-1)).toEqual({
      id: 'global.open_page_in_pane',
      observedDigest: '1234abcd',
    });

    const resetAll = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Restore Defaults'));
    await act(async () => resetAll?.click());
    expect(rendered.updates.at(-1)).toEqual({ resetAll: true, observedDigest: '1234abcd' });
  });

  test('follows external source changes', async () => {
    const rendered = await renderManager(view());
    await rendered.emit(withEntry(view(), 'global.open_page_in_pane', {
      desired: 'Control+P',
      effective: ['Control+P'],
      status: 'applied',
    }));
    expect(rendered.document.querySelector('[aria-label="Change Control+P"]')).not.toBeNull();
  });

  for (const outcome of ['success', 'failure'] as const) {
    test(`keeps newer bindings and their digest after a late initial read ${outcome}`, async () => {
      const initial = view();
      const pending = Promise.withResolvers<KeybindingsView>();
      const rendered = await renderManager(initial, false, () => pending.promise);
      const next = withEntry(view(), 'global.open_page_in_pane', {
        desired: 'Control+P',
        effective: ['Control+P'],
        status: 'applied',
      });
      await rendered.emit({
        ...next,
        source: { ...next.source, observedDigest: '8765dcba', acceptedDigest: '8765dcba' },
      });
      await act(async () => {
        if (outcome === 'success') pending.resolve(initial);
        else pending.reject(new Error('Initial read failed'));
      });

      const key = rendered.document.querySelector<HTMLButtonElement>('[aria-label="Change Control+P"]');
      expect(key).not.toBeNull();
      expect(rendered.document.querySelector('[aria-label="Change CommandOrControl+M"]')).toBeNull();
      expect(rendered.document.body.textContent).not.toContain('Initial read failed');

      await act(async () => key!.dispatchEvent(new rendered.window.Event('dblclick', { bubbles: true })));
      await act(async () => key!.dispatchEvent(keydown(rendered.window, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })));
      expect(rendered.updates.at(-1)).toEqual({
        id: 'global.open_page_in_pane',
        value: 'Control+Alt+K',
        observedDigest: '8765dcba',
      });
    });
  }

  test('shows an initial read failure and recovers when a source change arrives', async () => {
    const pending = Promise.withResolvers<KeybindingsView>();
    const rendered = await renderManager(view(), false, () => pending.promise);
    await act(async () => pending.reject(new Error('Initial read failed')));
    expect(rendered.document.body.textContent).toContain('Initial read failed');

    await rendered.emit(view());
    expect(rendered.document.body.textContent).not.toContain('Initial read failed');
    expect(rendered.document.querySelector('[aria-label="Change CommandOrControl+M"]')).not.toBeNull();
  });

  test('keeps file access out of ordinary shortcut controls', async () => {
    const rendered = await renderManager(view());
    expect(rendered.document.querySelector('[aria-label="Shortcut options"]')).toBeNull();
    expect(rendered.document.body.textContent).not.toContain('Open Keybindings File');
  });

  test('rejected source remains openable but disables structured edits', async () => {
    const rendered = await renderManager(view('rejected'));
    expect(rendered.document.body.textContent).toContain('keybindings file is invalid');
    expect(rendered.document.querySelector<HTMLButtonElement>('[aria-label="Change CommandOrControl+Shift+Space"]')?.disabled).toBe(true);
    const open = [...rendered.document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Open Keybindings File')!;
    await act(async () => open.click());
    expect(rendered.opened()).toBe(1);
  });
});

async function clickMenu(rendered: Rendered, label: string, action: string): Promise<void> {
  const row = [...rendered.document.querySelectorAll<HTMLElement>('.settings-shortcut-row')]
    .find((row) => `${row.querySelector('.settings-shortcut-label')?.textContent} actions` === label)!;
  await act(async () => row.dispatchEvent(new rendered.window.Event('contextmenu', { bubbles: true, cancelable: true })));
  const item = [...rendered.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === action);
  if (!item) throw new Error(`Missing action: ${action}`);
  await act(async () => item.click());
}

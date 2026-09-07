import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { MemorySettingsView } from '../../src/core/agent/memory';
import type { Thread } from '../../src/core/agent/protocol';
import { ThreadDetailsDialog } from '../../src/renderer/agent/components/ThreadDetailsDialog';
import { MemorySettingsGroup } from '../../src/renderer/ui/agent/MemorySettingsGroup';

interface Rendered {
  cleanup: () => void;
  document: Document;
  rerender: (element: React.ReactNode) => void;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals.reverse()) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('Memory settings', () => {
  test('loads and changes the global privacy mode without replacing the settings rows', async () => {
    const commands: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const errors: Array<string | null> = [];
    const notices: Array<string | null> = [];
    const rendered = renderWithBridge(async (name, args) => {
      commands.push({ name, args });
      if (name === 'memory_settings_get') return settings('enabled');
      if (name === 'memory_feature_mode_set') return settings(String(args?.mode) as 'enabled' | 'disabled');
      throw new Error(`Unexpected command: ${name}`);
    }, (
      <MemorySettingsGroup
        onError={(message) => errors.push(message)}
        onNotice={(message) => notices.push(message)}
      />
    ));
    await flushEffects();

    const toggle = rendered.document.querySelector<HTMLButtonElement>('[role="switch"]');
    if (!toggle) throw new Error('Missing Memory switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(rendered.document.querySelectorAll('.inset-row')).toHaveLength(3);

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(commands.at(-1)).toEqual({ name: 'memory_feature_mode_set', args: { mode: 'disabled' } });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(errors).toEqual([null]);
    expect(notices).toEqual([null, 'Memory disabled. Activity while disabled will not be remembered later.']);
  });

  test('requires confirmation before Reset and reports the completed operation', async () => {
    const commands: string[] = [];
    const notices: Array<string | null> = [];
    const rendered = renderWithBridge(async (name) => {
      commands.push(name);
      if (name === 'memory_settings_get' || name === 'memory_reset') return settings('enabled');
      throw new Error(`Unexpected command: ${name}`);
    }, (
      <MemorySettingsGroup onError={() => undefined} onNotice={(message) => notices.push(message)} />
    ));
    await flushEffects();

    const resetButton = [...rendered.document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Reset Memory');
    if (!resetButton) throw new Error('Missing Reset button');
    act(() => resetButton.click());
    expect(commands).toEqual(['memory_settings_get']);

    const confirm = rendered.document.querySelector<HTMLButtonElement>('.confirm-dialog .button-danger');
    if (!confirm) throw new Error('Missing Reset confirmation');
    expect(rendered.document.querySelector('.confirm-dialog')?.textContent)
      .toContain('including untagged ordinary notes');
    expect(rendered.document.querySelector('.confirm-dialog')?.textContent)
      .toContain('Notes outside those containers are preserved');
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });

    expect(commands).toEqual(['memory_settings_get', 'memory_reset']);
    expect(notices.at(-1)).toBe('Memory reset.');
    expect(rendered.document.querySelector('.confirm-dialog')).toBeNull();
  });

  test('surfaces stray reserved-tagged Nodes without exposing their identities', async () => {
    const rendered = renderWithBridge(async (name) => {
      if (name === 'memory_settings_get') return settings('enabled', undefined, 'enabled', 2);
      throw new Error(`Unexpected command: ${name}`);
    }, <MemorySettingsGroup onError={() => undefined} onNotice={() => undefined} />);
    await flushEffects();

    const status = [...rendered.document.querySelectorAll('.inset-row')]
      .find((row) => row.textContent?.includes('Timeline Memory'));
    expect(status?.textContent).toContain('2 reserved-tagged Nodes are outside the Memory timeline');
    expect(status?.textContent).not.toContain('stray:');
  });

  test('shows Thread Memory only for persistent root user Threads and persists its mode', async () => {
    const commands: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const thread = rootThread();
    const rendered = renderWithBridge(async (name, args) => {
      commands.push({ name, args });
      if (name === 'memory_settings_get') return settings('enabled', thread.id, 'enabled');
      if (name === 'memory_thread_mode_set') return settings('enabled', thread.id, 'disabled');
      throw new Error(`Unexpected command: ${name}`);
    }, <ThreadDetailsDialog onClose={() => undefined} thread={thread} turns={[]} />);
    await flushEffects();

    const toggle = rendered.document.querySelector<HTMLButtonElement>('[role="switch"]');
    if (!toggle) throw new Error('Missing Thread Memory switch');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(commands.at(-1)).toEqual({
      name: 'memory_thread_mode_set',
      args: { threadId: thread.id, mode: 'disabled' },
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    rendered.cleanup();
    const child = { ...thread, parentThreadId: '018f0f24-7b2e-7a3f-8a4b-123456789000' };
    const childRendered = renderWithBridge(async () => {
      throw new Error('Child Thread must not query Memory settings');
    }, <ThreadDetailsDialog onClose={() => undefined} thread={child} turns={[]} />);
    await flushEffects();
    expect(childRendered.document.querySelector('[role="switch"]')).toBeNull();
  });

  test('does not let an older settings refresh overwrite a completed mode change', async () => {
    const staleRefresh = deferred<MemorySettingsView>();
    let settingsReads = 0;
    const invoke = async (name: string, args?: Record<string, unknown>) => {
      if (name === 'memory_settings_get') {
        settingsReads += 1;
        return settingsReads === 1 ? settings('enabled') : staleRefresh.promise;
      }
      if (name === 'memory_feature_mode_set') {
        return settings(String(args?.mode) as 'enabled' | 'disabled');
      }
      throw new Error(`Unexpected command: ${name}`);
    };
    const rendered = renderWithBridge(invoke, (
      <MemorySettingsGroup onError={() => undefined} onNotice={() => undefined} />
    ));
    await flushEffects();
    rendered.rerender(<MemorySettingsGroup onError={(_message) => undefined} onNotice={() => undefined} />);
    await flushEffects();

    const toggle = rendered.document.querySelector<HTMLButtonElement>('[role="switch"]');
    if (!toggle) throw new Error('Missing Memory switch');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    staleRefresh.resolve(settings('enabled'));
    await flushEffects();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  test('does not let a previous Thread response replace the current Thread mode', async () => {
    const firstResponse = deferred<MemorySettingsView>();
    const secondResponse = deferred<MemorySettingsView>();
    const first = rootThread();
    const second = { ...rootThread(), id: '018f0f24-7b2e-7a3f-8a4b-123456789def', name: 'Second Thread' };
    const rendered = renderWithBridge(async (name, args) => {
      if (name !== 'memory_settings_get') throw new Error(`Unexpected command: ${name}`);
      return args?.threadId === first.id ? firstResponse.promise : secondResponse.promise;
    }, <ThreadDetailsDialog onClose={() => undefined} thread={first} turns={[]} />);
    await flushEffects();
    rendered.rerender(<ThreadDetailsDialog onClose={() => undefined} thread={second} turns={[]} />);
    await flushEffects();

    secondResponse.resolve(settings('enabled', second.id, 'disabled'));
    await flushEffects();
    const toggle = rendered.document.querySelector<HTMLButtonElement>('[role="switch"]');
    if (!toggle) throw new Error('Missing Thread Memory switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    firstResponse.resolve(settings('enabled', first.id, 'enabled'));
    await flushEffects();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

function renderWithBridge(
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
  element: React.ReactNode,
): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, { lin: { invoke } });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => root.render(element));
  let cleaned = false;
  const rendered = {
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      act(() => root.unmount());
    },
    document,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
  };
  mounted.push(rendered);
  return rendered;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

function settings(
  featureMode: 'enabled' | 'disabled',
  threadId?: string,
  threadMode: 'enabled' | 'disabled' = 'enabled',
  strayTaggedNodeCount = 0,
): MemorySettingsView {
  return {
    status: {
      featureMode,
      featureModeGeneration: 0,
      resetEpoch: 0,
      memoryVisibilityGeneration: 0,
      lastSuccessfulRunAt: null,
      lastError: null,
      pendingJobs: 0,
      strayTaggedNodeCount,
    },
    thread: threadId ? { threadId, mode: threadMode } : null,
  };
}

function rootThread(): Thread {
  return {
    id: '018f0f24-7b2e-7a3f-8a4b-123456789abc',
    sessionId: '018f0f24-7b2e-7a3f-8a4b-123456789abc',
    parentThreadId: null,
    forkedFromId: null,
    name: 'Memory test',
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'test',
    cwd: '/tmp',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'full',
    turns: [],
  };
}

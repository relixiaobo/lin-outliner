import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { MemoryInspectResult, MemoryResetView } from '../../src/core/agent/memoryOperations';
import type { Thread } from '../../src/core/agent/protocol';
import { ThreadDetailsDialog } from '../../src/renderer/agent/components/ThreadDetailsDialog';
import { MemorySettingsGroup } from '../../src/renderer/ui/agent/MemorySettingsGroup';

const cleanups: Array<() => void> = [];
const savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const [key, descriptor] of savedGlobals.splice(0).reverse()) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

describe('Memory owner UI', () => {
  test('writes the file-backed preference and waits for owner application', async () => {
    let enabled = true;
    const writes: unknown[] = [];
    const rendered = render(async (name, args) => {
      if (name === 'memory_inspect') return status(enabled);
      if (name === 'memory_enabled_update') { writes.push(args); return; }
      throw new Error(name);
    }, <MemorySettingsGroup />);
    await flush();
    const toggle = rendered.button('Use Memory');
    await act(async () => toggle.click());
    expect(writes).toEqual([{ enabled: false }]);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(rendered.document.body.textContent).toContain('Application is pending');
    enabled = false;
    rendered.changed();
    await flush();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(rendered.document.body.textContent).toContain('Memory disabled.');
    expect(rendered.document.querySelectorAll('.inset-row')).toHaveLength(3);
    enabled = true;
    rendered.changed();
    await flush();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(rendered.document.body.textContent).not.toContain('Application is pending');
  });

  test('Reset uses the native owner decision and only reports finalized as complete', async () => {
    let reset: MemoryResetView = { operationId: 'memory:reset:test', state: 'prepared', admittedAt: 1, targetEpoch: 1 };
    const rendered = render(async (name, args) => {
      const request = args?.request as { operation: string };
      if (name === 'memory_inspect') return request.operation === 'reset' ? { operation: 'reset', reset } : status(true);
      if (name === 'memory_manage') return { operation: 'reset', reset };
      throw new Error(name);
    }, <MemorySettingsGroup />);
    await flush();
    await act(async () => rendered.button('Reset Memory').click());
    expect(rendered.document.querySelector('.confirm-dialog')).toBeNull();
    expect(rendered.document.body.textContent).toContain('Reset is awaiting settlement.');
    expect(rendered.document.body.textContent).not.toContain('Memory reset.');
    expect(rendered.button('Reset Memory').disabled).toBe(true);
    reset = { ...reset, state: 'finalized' };
    rendered.changed();
    await flush();
    expect(rendered.document.body.textContent).toContain('Memory reset.');
    expect(rendered.button('Reset Memory').disabled).toBe(false);
  });

  test('keeps cancellation, failure and navigation outcomes local', async () => {
    const rendered = render(async (name, args) => {
      if (name === 'memory_inspect') return status(true);
      if ((args?.request as { operation: string }).operation === 'reset') throw new Error('Memory Reset was cancelled.');
      return { operation: 'open', nodeId: 'search', navigation: 'unknown' };
    }, <MemorySettingsGroup />);
    await flush();
    await act(async () => rendered.button('Reset Memory').click());
    expect(rendered.document.querySelector('[role="alert"]')?.textContent).toContain('cancelled');
    await act(async () => rendered.button('Open Memory').click());
    expect(rendered.document.querySelector('[role="alert"]')).toBeNull();
    expect(rendered.document.querySelector('[role="status"]')?.textContent).toContain('navigation was not confirmed');
  });

  test('owner events refresh without parent callback churn and release on close', async () => {
    let reads = 0;
    const rendered = render(async () => { reads++; return status(true, undefined, true, 2); }, <MemorySettingsGroup />);
    await flush();
    expect(rendered.document.body.textContent).toContain('2 reserved-tagged Nodes');
    rendered.rerender(<MemorySettingsGroup />);
    await flush();
    expect(reads).toBe(1);
    rendered.changed();
    await flush();
    expect(reads).toBe(2);
    rendered.cleanup();
    expect(rendered.listeners.size).toBe(0);
    rendered.changed();
    expect(reads).toBe(2);
  });

  test('ignores an older status request after a newer owner invalidation', async () => {
    const stale = deferred<MemoryInspectResult>();
    let reads = 0;
    const rendered = render(async () => ++reads === 2 ? stale.promise : status(reads === 1), <MemorySettingsGroup />);
    await flush();
    rendered.changed();
    await flush();
    rendered.changed();
    await flush();
    expect(rendered.button('Use Memory').getAttribute('aria-checked')).toBe('false');
    stale.resolve(status(true));
    await flush();
    expect(rendered.button('Use Memory').getAttribute('aria-checked')).toBe('false');
  });

  test('Thread mode writes the inspected revision and refreshes after conflict', async () => {
    const thread = rootThread('thread:first');
    let enabled = true;
    let revision = 4;
    const writes: unknown[] = [];
    const rendered = render(async (name, args) => {
      if (name === 'memory_inspect') {
        const result = status(true, thread.id, enabled);
        if (result.operation === 'status' && result.thread) return { ...result, thread: { ...result.thread, revision } };
      }
      writes.push(args?.request);
      enabled = false;
      revision++;
      throw new Error('The Thread Memory mode changed. Inspect it again.');
    }, <ThreadDetailsDialog onClose={() => {}} thread={thread} turns={[]} />);
    await flush();
    await act(async () => rendered.button('Memory for this Thread').click());
    expect(writes).toEqual([{ operation: 'set_thread_mode', threadId: thread.id, mode: 'disabled', expectedRevision: 4 }]);
    expect(rendered.button('Memory for this Thread').getAttribute('aria-checked')).toBe('false');
    expect(rendered.document.querySelector('[role="alert"]')?.textContent).toContain('mode changed');
  });

  test('previous Thread responses cannot replace the current target', async () => {
    const old = deferred<MemoryInspectResult>();
    const first = rootThread('thread:first');
    const second = rootThread('thread:second');
    const rendered = render(async (_name, args) => (args?.request as { threadId: string }).threadId === first.id
      ? old.promise : status(true, second.id, false), <ThreadDetailsDialog onClose={() => {}} thread={first} turns={[]} />);
    rendered.rerender(<ThreadDetailsDialog onClose={() => {}} thread={second} turns={[]} />);
    await flush();
    old.resolve(status(true, first.id, true));
    await flush();
    expect(rendered.button('Memory for this Thread').getAttribute('aria-checked')).toBe('false');
  });

  test('ineligible Threads expose no mode control or subscription', async () => {
    const thread = { ...rootThread('child'), parentThreadId: 'parent' };
    const rendered = render(async () => { throw new Error('Must not read Memory'); }, <ThreadDetailsDialog onClose={() => {}} thread={thread} turns={[]} />);
    await flush();
    expect(rendered.document.querySelector('[role="switch"]')).toBeNull();
    expect(rendered.listeners.size).toBe(0);
  });
});

function render(invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>, element: React.ReactNode) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'MouseEvent', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key] });
  }
  const listeners = new Set<() => void>();
  Object.assign(window, { lin: { invoke, onMemoryChanged: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } } });
  const root = createRoot(document.getElementById('root')!);
  act(() => root.render(element));
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; act(() => root.unmount()); } };
  cleanups.push(cleanup);
  return { document, cleanup, listeners,
    changed: () => act(() => { for (const listener of listeners) listener(); }),
    rerender: (element: React.ReactNode) => act(() => root.render(element)),
    button: (name: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === name || entry.getAttribute('aria-label') === name);
      if (!button) throw new Error(`Missing button: ${name}`);
      return button;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { resolve, promise };
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function status(enabled: boolean, threadId?: string, threadEnabled = true, strayTaggedNodeCount = 0): MemoryInspectResult {
  return { operation: 'status', status: { featureMode: enabled ? 'enabled' : 'disabled', featureModeGeneration: 0,
    resetEpoch: 0, memoryVisibilityGeneration: 0, lastSuccessfulRunAt: null, lastError: null, pendingJobs: 0, strayTaggedNodeCount },
    thread: threadId ? { threadId, mode: threadEnabled ? 'enabled' : 'disabled', revision: 0, appliesAt: 'subsequent_admissions' } : null };
}
function rootThread(id: string): Thread {
  return { id, sessionId: id, parentThreadId: null, forkedFromId: null, name: 'Memory test', preview: '', ephemeral: false,
    source: 'app', threadSource: 'user', modelProvider: 'test', configurationSource: { kind: 'user' }, cwd: '/tmp', createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, historyMode: 'full', turns: [] };
}

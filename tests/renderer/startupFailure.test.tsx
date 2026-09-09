import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { initialStartupState, type StartupState } from '../../src/core/startup';
import type { LinApi } from '../../src/preload';
import { StartupFailure } from '../../src/renderer/ui/StartupFailure';
import { useStartupState } from '../../src/renderer/ui/useStartupState';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

test('an Agent-only retry preserves the healthy projection and ignores older responses', async () => {
  let listener!: (state: StartupState) => void;
  let settleRetry!: (state: StartupState) => void;
  const unavailable: StartupState = { ...initialStartupState(), revision: 2, status: 'failed',
    step: 'agent', message: 'Agent unavailable', capabilities: { outline: 'ready', agent: 'unavailable' } };
  const fixture = render({ get: async () => unavailable,
    onChanged: (next) => { listener = next; return () => undefined; },
    retry: () => new Promise((resolve) => { settleRetry = resolve; }), quit: async () => undefined });
  await act(async () => undefined);
  let retry!: Promise<void>;
  act(() => { retry = fixture.current().retry(); });
  await act(async () => {
    listener({ ...unavailable, revision: 5, message: 'Newer failure' });
    settleRetry({ ...initialStartupState(true), revision: 4 });
    await retry;
  });
  expect(fixture.current().failure?.message).toBe('Newer failure');
  expect(fixture.current().workspaceFailure).toBe(false);
  expect(fixture.current().projectionAttempt).toBe(0);
});

test('a rejected retry cannot erase a newer live owner state', async () => {
  let listener!: (state: StartupState) => void;
  let rejectRetry!: (error: Error) => void;
  const fixture = render({ get: async () => initialStartupState(),
    onChanged: (next) => { listener = next; return () => undefined; },
    retry: () => new Promise((_resolve, reject) => { rejectRetry = reject; }), quit: async () => undefined });
  await act(async () => undefined);
  let retry!: Promise<void>;
  act(() => { retry = fixture.current().retry(); });
  await act(async () => {
    listener({ ...initialStartupState(true), revision: 8 });
    rejectRetry(new Error('Old request failed'));
    await retry;
  });
  expect(fixture.current().state.capabilities.agent).toBe('ready');
  expect(fixture.current().failure).toBeNull();
});

test('a late startup snapshot cannot erase a live failure and Retry renews projection readiness', async () => {
  let resolveSnapshot!: (state: StartupState) => void;
  let listener: ((state: StartupState) => void) | undefined;
  let retries = 0;
  let quits = 0;
  let unsubscribed = false;
  const fixture = render({
    get: () => new Promise((resolve) => { resolveSnapshot = resolve; }),
    onChanged: (next) => { listener = next; return () => { unsubscribed = true; }; },
    retry: async () => { retries += 1; return { ...initialStartupState(true), revision: 3 }; },
    quit: async () => { quits += 1; },
  });
  await act(async () => {
    listener?.({ ...initialStartupState(), status: 'failed', revision: 2, step: 'outline-documents', message: 'Snapshot is unreadable' });
    resolveSnapshot(initialStartupState());
  });
  expect(fixture.document.querySelector('[role=alert]')?.textContent).toContain('Unable to open your workspace');
  expect(fixture.current().failure?.message).toBe('Snapshot is unreadable');
  expect(fixture.current().projectionAttempt).toBe(0);
  await act(async () => fixture.current().retry());
  expect(retries).toBe(1);
  expect(fixture.current().projectionAttempt).toBe(1);
  expect(fixture.document.querySelector('[role=alert]')).toBeNull();
  await act(async () => fixture.current().quit());
  expect(quits).toBe(1);
  cleanup?.();
  cleanup = undefined;
  expect(unsubscribed).toBe(true);
});

test('a terminal projection failure stays actionable even when Host startup succeeded', async () => {
  const fixture = render({
    get: async () => ({ ...initialStartupState(true), revision: 3 }),
    onChanged: () => () => undefined,
    retry: async () => ({ ...initialStartupState(true), revision: 3 }),
    quit: async () => undefined,
  });
  await act(async () => undefined);
  act(() => fixture.current().setProjectionFailure('Projection cannot be decoded'));
  expect(fixture.document.querySelector('[role=alert]')?.textContent).toContain('Projection cannot be decoded');
  expect([...fixture.document.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Retry', 'Quit']);
  await act(async () => fixture.current().retry());
  expect(fixture.current().failure).toBeNull();
  expect(fixture.current().projectionAttempt).toBe(1);
});

function render(startup: Omit<LinApi['startup'], 'issueAction'>) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = {
    window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const previousLin = window.lin;
  Object.assign(window, { lin: { startup } });
  const root = createRoot(document.getElementById('root')!);
  let value!: ReturnType<typeof useStartupState>;
  function Harness() {
    value = useStartupState();
    return value.failure ? <StartupFailure
      failure={value.failure}
      retrying={value.retrying}
      onRetry={() => void value.retry()}
      onQuit={value.quit}
    /> : null;
  }
  act(() => root.render(<Harness />));
  cleanup = () => {
    act(() => root.unmount());
    Object.assign(window, { lin: previousLin });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { document, current: () => value };
}

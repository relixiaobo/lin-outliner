import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LauncherApp } from '../../src/renderer/launcher/LauncherApp';
import type { ExternalContext } from '../../src/core/launcher/context';

// Component tests for the launcher's effectful interaction fixes (re-entrancy lock,
// capture routing). The pure selection/list logic is covered in launcherModel.test.ts;
// here we drive the real component through a mocked `window.lin.launcher`.

interface LauncherMock {
  calls: {
    executeCommand: unknown[];
    createContextCapture: { note?: unknown }[];
    createCapture: unknown[];
    openNode: string[];
    hide: number;
  };
  pushContext: (ctx: ExternalContext) => void;
  launcher: Record<string, unknown>;
}

function makeLauncherMock(): LauncherMock {
  const calls = { executeCommand: [] as unknown[], createContextCapture: [] as { note?: unknown }[], createCapture: [] as unknown[], openNode: [] as string[], hide: 0 };
  let contextCb: ((ctx: ExternalContext) => void) | null = null;
  const launcher = {
    getInitialState: async () => ({
      commands: [
        { id: 'open-main', title: 'Open main window' },
        { id: 'open-settings', title: 'Open Settings' },
      ],
      hotkey: 'CommandOrControl+Shift+Space',
    }),
    onShown: () => () => {},
    onContext: (cb: (ctx: ExternalContext) => void) => { contextCb = cb; return () => { contextCb = null; }; },
    hide: () => { calls.hide++; },
    executeCommand: async (id: unknown) => { calls.executeCommand.push(id); return { hide: true }; },
    createCapture: async (payload: unknown) => { calls.createCapture.push(payload); return { ok: true, nodeId: 'n1' }; },
    createContextCapture: async (payload: { note?: unknown }) => { calls.createContextCapture.push(payload); return { ok: true, nodeId: 'n1' }; },
    searchNodes: async () => [],
    openNode: (id: string) => { calls.openNode.push(id); },
  };
  return { calls, launcher, pushContext: (ctx) => contextCb?.(ctx) };
}

function webpageContext(): ExternalContext {
  return {
    id: 'ctx-1',
    capturedAt: '2026-06-04T00:00:00',
    captureOrigin: 'global-hotkey',
    app: { name: 'Safari' },
    browser: { name: 'Safari', hostname: 'example.com', url: 'https://example.com/post' },
    providerId: 'generic-webpage',
    confidence: 'probable',
    source: {
      kind: 'article',
      title: 'An Example Article',
      original: { kind: 'remote-url', url: 'https://example.com/post', preview: 'web-preview' },
      url: 'https://example.com/post',
      providerId: 'generic-webpage',
    },
    warnings: [],
    permissions: [],
  };
}

interface Rendered { cleanup: () => void; document: Document; window: Window & typeof globalThis; mock: LauncherMock; }
const mounted: Rendered[] = [];
afterEach(() => { while (mounted.length) mounted.pop()?.cleanup(); });

function installDomGlobals(window: Window & typeof globalThis, mock: LauncherMock) {
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
  // linkedom has no layout — stub scrollIntoView (the active-row keep-in-view effect).
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  (window as unknown as { lin: unknown }).lin = { launcher: mock.launcher };
}

async function renderLauncher(): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as { document: Document; window: Window & typeof globalThis };
  const mock = makeLauncherMock();
  installDomGlobals(window, mock);
  const container = document.getElementById('root')!;
  const root: Root = createRoot(container);
  await act(async () => { root.render(<LauncherApp />); });
  // Flush getInitialState().then(setState) so the command rows exist.
  await act(async () => {});
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window, mock };
  mounted.push(rendered);
  return rendered;
}

function rows(r: Rendered): HTMLElement[] {
  return Array.from(r.document.querySelectorAll<HTMLElement>('[role="option"]'));
}

describe('LauncherApp interaction', () => {
  test('loads commands into uniform rows', async () => {
    const r = await renderLauncher();
    const titles = rows(r).map((row) => row.querySelector('.launcher-row-title')?.textContent);
    expect(titles).toContain('Open main window');
    expect(titles).toContain('Open Settings');
  });

  test('a double-click on a command row fires the action only once (re-entrancy lock)', async () => {
    const r = await renderLauncher();
    const first = rows(r)[0];
    await act(async () => {
      first.dispatchEvent(new r.window.Event('click', { bubbles: true }));
      first.dispatchEvent(new r.window.Event('click', { bubbles: true }));
    });
    expect(r.mock.calls.executeCommand).toEqual(['open-main']);
  });

  test('Enter on a page-capture row routes to createContextCapture, not a command', async () => {
    // Wiring coverage for the capture-page branch of runAction: with a captured
    // page context present, the top (capture-first) row's Enter must hit
    // createContextCapture — never executeCommand. The note that rides along comes
    // from the query and is derived/covered purely in launcherModel.test.ts
    // (buildLauncherItems); we don't re-assert it here because React's controlled
    // onChange does not fire under linkedom (no full DOM value-tracking), so the
    // typed note isn't drivable through the input in this environment.
    const r = await renderLauncher();
    await act(async () => { r.mock.pushContext(webpageContext()); });

    const dialog = r.document.querySelector<HTMLElement>('.launcher')!;
    await act(async () => {
      const ev = new r.window.Event('keydown', { bubbles: true }) as Event & { key: string };
      ev.key = 'Enter';
      dialog.dispatchEvent(ev);
    });
    expect(r.mock.calls.createContextCapture).toHaveLength(1);
    expect(r.mock.calls.createContextCapture[0]).toEqual({ note: undefined });
    expect(r.mock.calls.executeCommand).toHaveLength(0);
  });
});

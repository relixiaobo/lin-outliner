import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LauncherApp } from '../../src/renderer/launcher/LauncherApp';
import type {
  ActionRequestResult,
  InvocationOpened,
  ObjectRef,
  SurfaceItemPresentation,
} from '../../src/core/actions/types';
import { APP_NAME } from '../../src/core/brand';

// Component tests for the launcher's effectful interaction guarantees:
// re-entrancy, the IME guard, synchronous Enter, the footer's status/hint split,
// and — new with the object model — that Enter NAMES an action rather than
// choosing an effect. The pure row/activity logic is covered in
// launcherModel.test.ts.

interface LauncherMockOptions {
  hotkey?: string | null;
  /** What `actions.request` resolves to; the failure path keeps the panel open. */
  result?: ActionRequestResult;
  /** Delay the opening push, to model the summon->context window. */
  deferOpening?: boolean;
  opening?: InvocationOpened;
}

interface LauncherMock {
  calls: { request: unknown[]; hide: number; event: unknown[]; queryObjects: unknown[] };
  pushOpening: () => void;
  triggerShown: () => void;
  bridge: Record<string, unknown>;
}

function item(name: string, kind: 'node' | 'appSurface', ref: string, primary?: string): SurfaceItemPresentation {
  return {
    object: {
      objectRef: ref as ObjectRef,
      ...(kind === 'node'
        ? { kind: 'node' as const, node: { kind: 'document' as const, nodeType: null } }
        : { kind: 'appSurface' as const, surface: 'settings' as const }),
      name: { source: 'localized', values: { en: name, 'zh-Hans': name } },
      typeLabel: { en: 'App', 'zh-Hans': 'App' },
    },
    ...(primary
      ? {
        primaryAction: {
          actionId: 'open',
          subjectRef: ref as ObjectRef,
          names: { en: primary, 'zh-Hans': primary },
          aliases: [],
          surfaces: ['actionPanel'],
          evaluation: { status: 'applicable' },
          binding: { state: 'ready', arguments: {} },
        } as never,
      }
      : {}),
    actions: [],
  };
}

function opening(): InvocationOpened {
  return {
    invocationRef: 'inv-1' as never,
    openSeq: 1,
    ambient: { state: 'pending', revision: 0 },
    fixedItems: [],
    resultItems: [
      item('Today', 'node', 'ref-today', 'Open'),
      item('Settings', 'appSurface', 'ref-settings', 'Open'),
    ],
    menuActions: [],
  };
}

function fileSourceOpening(): InvocationOpened {
  const resource = item('Quarterly call recording.wav', 'node', 'ref-file', 'Open');
  resource.object = {
    ...resource.object,
    name: { source: 'literal', value: 'Quarterly call recording.wav' },
    typeLabel: { en: 'Node', 'zh-Hans': '节点' },
  };
  return { ...opening(), resultItems: [resource] };
}

function makeLauncherMock(options: LauncherMockOptions = {}): LauncherMock {
  const { hotkey = 'CommandOrControl+Shift+Space', result = { status: 'completed' } } = options;
  const calls = { request: [] as unknown[], hide: 0, event: [] as unknown[], queryObjects: [] as unknown[] };
  let shownCb: (() => void) | null = null;
  let openedCb: ((next: InvocationOpened) => void) | null = null;
  const bridge = {
    launcher: {
      getInitialState: async () => ({ hotkey }),
      onShown: (cb: () => void) => { shownCb = cb; return () => { shownCb = null; }; },
      onRemediation: () => () => undefined,
      hide: () => { calls.hide++; },
    },
    actions: {
      onOpened: (cb: (next: InvocationOpened) => void) => {
        openedCb = cb;
        return () => { openedCb = null; };
      },
      onAmbientChanged: () => () => undefined,
      queryObjects: async (request: unknown) => {
        calls.queryObjects.push(request);
        return { status: 'superseded' };
      },
      queryParameters: async () => ({ status: 'superseded' }),
      request: async (request: unknown) => {
        calls.request.push(request);
        return result;
      },
      event: async (next: unknown) => { calls.event.push(next); return { status: 'spent' }; },
    },
  };
  return {
    calls,
    bridge,
    pushOpening: () => openedCb?.(options.opening ?? opening()),
    triggerShown: () => shownCb?.(),
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
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
  if (!proto.focus) proto.focus = () => {};
  if (!proto.select) proto.select = () => {};
  (window as unknown as { lin: unknown }).lin = mock.bridge;
}

async function renderLauncher(options: LauncherMockOptions = {}): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as { document: Document; window: Window & typeof globalThis };
  const mock = makeLauncherMock(options);
  installDomGlobals(window, mock);
  const container = document.getElementById('root')!;
  const root: Root = createRoot(container);
  await act(async () => { root.render(<LauncherApp />); });
  await act(async () => {});
  if (!options.deferOpening) {
    await act(async () => { mock.pushOpening(); });
  }
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window, mock };
  mounted.push(rendered);
  return rendered;
}

function rows(r: Rendered): HTMLElement[] {
  return Array.from(r.document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function statusText(r: Rendered): string {
  return r.document.querySelector<HTMLElement>('.launcher-actionbar-status')?.textContent ?? '';
}

function primaryHintText(r: Rendered): string {
  return r.document.querySelector<HTMLElement>('.launcher-actionbar-primary')?.textContent ?? '';
}

function selectedTitles(r: Rendered): (string | null | undefined)[] {
  return rows(r)
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.querySelector('.launcher-row-title')?.textContent);
}

async function pressKey(r: Rendered, key: string, options: { composing?: boolean } = {}) {
  const dialog = r.document.querySelector<HTMLElement>('.launcher')!;
  await act(async () => {
    const ev = new r.window.Event('keydown', { bubbles: true }) as Event & { key: string; keyCode?: number };
    ev.key = key;
    // React's synthetic event carries no `isComposing`, so the shipped guard keys
    // on the legacy 229 / 'Process' fallbacks — what an IME actually sends.
    if (options.composing) ev.keyCode = 229;
    dialog.dispatchEvent(ev);
  });
}

async function clickRow(r: Rendered, index: number) {
  await act(async () => {
    rows(r)[index]?.dispatchEvent(new r.window.Event('click', { bubbles: true }));
  });
}

describe('LauncherApp rows are objects', () => {
  test('renders the opening main pushed, as uniform object rows', async () => {
    const r = await renderLauncher();
    expect(rows(r).map((row) => row.querySelector('.launcher-row-title')?.textContent))
      .toEqual(['Today', 'Settings']);
  });

  test('the panel renders nothing until main pushes an opening', async () => {
    const r = await renderLauncher({ deferOpening: true });
    // No locally-invented rows: the renderer has no object model of its own.
    expect(rows(r)).toHaveLength(0);
  });

  test('a Source-backed document keeps its node identity and authored title', async () => {
    const r = await renderLauncher({ opening: fileSourceOpening() });
    const row = rows(r)[0]!;
    expect(row.querySelector('.launcher-row-title')?.textContent).toBe('Quarterly call recording.wav');
    expect(row.querySelector('.launcher-row-type')?.textContent).toBe('Node');
    expect(row.querySelector('.object-glyph-bullet')).not.toBeNull();
    expect(row.querySelector('[data-icon="File"]')).toBeNull();
  });
});

describe('LauncherApp interaction', () => {
  test('Enter NAMES an action; it never chooses an effect', async () => {
    const r = await renderLauncher();
    await pressKey(r, 'Enter');
    expect(r.mock.calls.request).toEqual([{
      actionId: 'open',
      invocationRef: 'inv-1',
      subjectRef: 'ref-today',
      arguments: {},
    }]);
  });

  test('a double-click fires the action only once (re-entrancy lock)', async () => {
    const r = await renderLauncher();
    await act(async () => {
      rows(r)[0]?.dispatchEvent(new r.window.Event('click', { bubbles: true }));
      rows(r)[0]?.dispatchEvent(new r.window.Event('click', { bubbles: true }));
    });
    expect(r.mock.calls.request).toHaveLength(1);
  });

  test('clicking a row acts on THAT row, not the active one', async () => {
    const r = await renderLauncher();
    await clickRow(r, 1);
    expect((r.mock.calls.request[0] as { subjectRef: string }).subjectRef).toBe('ref-settings');
  });

  test('a completed action hides the panel', async () => {
    const r = await renderLauncher();
    await pressKey(r, 'Enter');
    expect(r.mock.calls.hide).toBe(1);
  });

  test('a failed action keeps the panel open and says so', async () => {
    const r = await renderLauncher({ result: { status: 'stale', reason: 'subject' } });
    await pressKey(r, 'Enter');
    expect(r.mock.calls.hide).toBe(0);
    expect(statusText(r)).not.toBe('');
    // The hint still names the action; the failure lives in the status zone.
    expect(primaryHintText(r)).toContain('Open');
  });

  test('Escape abandons the invocation before hiding', async () => {
    const r = await renderLauncher();
    await pressKey(r, 'Escape');
    expect(r.mock.calls.event).toEqual([{ kind: 'abandoned', invocationRef: 'inv-1' }]);
    expect(r.mock.calls.hide).toBe(1);
  });
});

describe('LauncherApp IME composition guard', () => {
  test('Enter committing an IME candidate fires no action', async () => {
    const r = await renderLauncher();
    await pressKey(r, 'Enter', { composing: true });
    expect(r.mock.calls.request).toEqual([]);
  });

  test('arrows during composition belong to the IME — activity does not move', async () => {
    const r = await renderLauncher();
    expect(selectedTitles(r)).toEqual(['Today']);
    await pressKey(r, 'ArrowDown', { composing: true });
    expect(selectedTitles(r)).toEqual(['Today']);
    await pressKey(r, 'ArrowDown');
    expect(selectedTitles(r)).toEqual(['Settings']);
  });

  test('Escape during composition does not hide the window; a later Escape does', async () => {
    const r = await renderLauncher();
    await pressKey(r, 'Escape', { composing: true });
    expect(r.mock.calls.hide).toBe(0);
    await pressKey(r, 'Escape');
    expect(r.mock.calls.hide).toBe(1);
  });
});

describe('LauncherApp Enter is synchronous', () => {
  test('Enter acts on the row that is showing, with no deferred continuation', async () => {
    const r = await renderLauncher();
    // The opening arrived with a READY generation, so the top row is already a
    // legal subject — there is no window in which Enter waits for context and
    // then fires against something the user never saw.
    await pressKey(r, 'Enter');
    expect((r.mock.calls.request[0] as { subjectRef: string }).subjectRef).toBe('ref-today');
  });

  test('Enter before any opening does nothing at all', async () => {
    const r = await renderLauncher({ deferOpening: true });
    await pressKey(r, 'Enter');
    expect(r.mock.calls.request).toEqual([]);
    expect(r.mock.calls.hide).toBe(0);
  });
});

describe('LauncherApp footer', () => {
  test('at rest the status zone is the identity: the app mark plus the hotkey', async () => {
    const r = await renderLauncher();
    expect(statusText(r)).toContain(APP_NAME);
    expect(statusText(r)).toContain('⌘⇧Space');
  });

  test('no hotkey registered → the identity renders without one', async () => {
    const r = await renderLauncher({ hotkey: null });
    expect(statusText(r)).toContain(APP_NAME);
    expect(statusText(r)).not.toContain('⌘');
  });

  test('the primary hint states the VERB, never the row title', async () => {
    const r = await renderLauncher();
    expect(primaryHintText(r)).toContain('Open');
    expect(primaryHintText(r)).not.toContain('Today');
  });
});

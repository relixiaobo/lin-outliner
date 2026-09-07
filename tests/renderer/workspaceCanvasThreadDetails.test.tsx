import { afterEach, expect, test } from 'bun:test';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import type { DocumentIndex, UiState } from '../../src/renderer/state/document';
import { WorkspaceCanvas } from '../../src/renderer/ui/WorkspaceCanvas';
import type { WorkspacePanelState } from '../../src/renderer/ui/workspaceLayoutTypes';

const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

test('Trajectory closes its pane when no Back destination remains', () => {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(Date.now());
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    lin: {
      initialLanguage: 'en',
      onLanguageChanged: () => () => undefined,
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: () => new Promise(() => undefined),
    },
  });
  const panels: WorkspacePanelState[] = [
    {
      id: 'panel-no-back',
      type: 'workspace',
      size: 1,
      view: { kind: 'thread-trajectory', threadId: 'thread-alpha', turnId: 'turn-one' },
      backStack: [],
      forwardStack: [],
    },
    {
      id: 'panel-with-back',
      type: 'workspace',
      size: 1,
      view: { kind: 'thread-trajectory', threadId: 'thread-beta', turnId: 'turn-two' },
      backStack: [{ kind: 'outliner', rootId: 'today' }],
      forwardStack: [],
    },
  ];
  const backCalls: string[] = [];
  const closeCalls: string[] = [];
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);

  act(() => {
    root.render(
      <I18nProvider>
        <WorkspaceCanvas
          activePanelId="panel-no-back"
          panels={panels}
          canvasRef={createRef<HTMLElement>()}
          dragId={null}
          index={{} as DocumentIndex}
          isNodePinned={() => false}
          onActivatePanel={() => undefined}
          onClosePanel={(panelId) => closeCalls.push(panelId)}
          onError={() => undefined}
          onMovePanel={() => undefined}
          onNavigatePanelBack={(panelId) => backCalls.push(panelId)}
          onNavigatePanelPreview={() => undefined}
          onNavigatePanelRoot={() => undefined}
          onPanelResizeKeyDown={() => undefined}
          onPanelResizeReset={() => undefined}
          onPanelResizeStart={() => undefined}
          onPanelScrollPositionChange={() => undefined}
          onTogglePin={() => undefined}
          run={async () => null}
          setDragId={() => undefined}
          setTrigger={() => undefined}
          setUi={() => undefined}
          trigger={null}
          ui={{} as UiState}
        />
      </I18nProvider>,
    );
  });
  mounted.push(() => act(() => root.unmount()));

  const noBackClose = document.querySelector<HTMLButtonElement>(
    '[data-panel-id="panel-no-back"] .panel-breadcrumb-close',
  );
  const withBackClose = document.querySelector<HTMLButtonElement>(
    '[data-panel-id="panel-with-back"] .panel-breadcrumb-close',
  );
  if (!noBackClose || !withBackClose) throw new Error('Missing pane close control');

  act(() => noBackClose.click());
  act(() => withBackClose.click());

  expect(closeCalls).toEqual(['panel-no-back']);
  expect(backCalls).toEqual(['panel-with-back']);
});

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

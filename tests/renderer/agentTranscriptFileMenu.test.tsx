import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  AgentTranscriptFileMenu,
  type AgentTranscriptFile,
} from '../../src/renderer/ui/agent/AgentTranscriptFileMenu';
import { onAddPreviewTargetToOutlineRequest } from '../../src/renderer/ui/preview/previewIngest';
import { getMessages } from '../../src/core/i18n';
import type { PreviewTarget } from '../../src/core/preview';

// The transcript file chip's right-click menu: Add to Today / Open with default app /
// Show in Finder. Add-to-Today fires the ingest bridge with just the file target; App
// owns the destination (it ensures today's date node through the command runner and
// creates the node under it). The other two actions hit the OS seam.

const labels = getMessages('en').agent.filePreview;

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

interface AddRequest {
  panelId?: string;
  target: PreviewTarget;
}

interface LinStub {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  openLocalFile?: (options: { path: string }) => Promise<unknown>;
  revealLocalFile?: (options: { path: string }) => Promise<unknown>;
}

const mounted: Rendered[] = [];
let detachBridge: (() => void) | null = null;

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  detachBridge?.();
  detachBridge = null;
  // Leave `globalThis.window` in place: React's scheduler may still hold a pending
  // task that reads it after unmount, and deleting it races a "window is not defined"
  // teardown error (other renderer tests keep the DOM globals between cases too).
});

const FILE: AgentTranscriptFile = {
  path: '/workdir/report.md',
  name: 'report.md',
  entryKind: 'file',
};

describe('AgentTranscriptFileMenu', () => {
  test('renders the three transcript actions', () => {
    const rendered = render(FILE, {});
    const items = Array.from(rendered.document.body.querySelectorAll('.node-context-item'));
    expect(items.map((item) => item.textContent)).toEqual([
      labels.addToToday,
      labels.openWithDefaultApp,
      labels.showInFinder,
    ]);
  });

  test('"Add to Today" fires the ingest bridge with the file target (App owns the destination)', async () => {
    const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const requests: AddRequest[] = [];
    detachBridge = onAddPreviewTargetToOutlineRequest(async (request) => {
      requests.push(request);
      return true;
    });
    const rendered = render(FILE, {
      invoke: (command, args) => {
        invokeCalls.push({ command, args });
        return Promise.resolve(null);
      },
    });

    await clickItem(rendered, labels.addToToday);

    // The menu no longer ensures the date node itself — that moved to App's bridge
    // handler (which routes through the command runner so the index stays consistent).
    expect(invokeCalls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.panelId).toBeUndefined();
    expect(requests[0]?.target).toEqual({
      kind: 'local-file',
      path: FILE.path,
      entryKind: 'file',
      label: FILE.name,
    });
  });

  test('"Open with default app" opens via the OS seam', async () => {
    const opened: Array<{ path: string }> = [];
    const rendered = render(FILE, {
      openLocalFile: (options) => { opened.push(options); return Promise.resolve(); },
    });

    await clickItem(rendered, labels.openWithDefaultApp);
    expect(opened).toEqual([{ path: FILE.path }]);
  });

  test('"Show in Finder" reveals via the OS seam', async () => {
    const revealed: Array<{ path: string }> = [];
    const rendered = render(FILE, {
      revealLocalFile: (options) => { revealed.push(options); return Promise.resolve(); },
    });

    await clickItem(rendered, labels.showInFinder);
    expect(revealed).toEqual([{ path: FILE.path }]);
  });
});

function render(file: AgentTranscriptFile, lin: LinStub): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  // The component reads `window.lin` (seam) and `api` reads `window.lin.invoke`; attach
  // the stub to the SAME linkedom window the overlay layout hook reads (rAF/innerWidth).
  (window as unknown as { lin: LinStub }).lin = lin;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <AgentTranscriptFileMenu file={file} onClose={() => {}} x={20} y={20} />,
    );
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
  mounted.push(rendered);
  return rendered;
}

async function clickItem(rendered: Rendered, label: string) {
  const item = Array.from(rendered.document.body.querySelectorAll('.node-context-item'))
    .find((node) => node.textContent === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await act(async () => {
    item.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
  // Flush the async bridge/ensure-date work the click kicked off.
  await act(async () => { await Promise.resolve(); });
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

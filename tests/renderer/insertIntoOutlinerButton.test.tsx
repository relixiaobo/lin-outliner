import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { InsertIntoOutlinerButton } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { onInsertFileIntoOutlinerRequest } from '../../src/renderer/agent/agentFileInsert';
import { getMessages } from '../../src/core/i18n';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const labels = getMessages('en').agent.toolCall;
const mounted: Rendered[] = [];
let detachBridge: (() => void) | null = null;

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  detachBridge?.();
  detachBridge = null;
});

describe('InsertIntoOutlinerButton', () => {
  test('clicking fires the ingest bridge with the working-file path', async () => {
    const requested: string[] = [];
    detachBridge = onInsertFileIntoOutlinerRequest(async (path) => {
      requested.push(path);
      return true;
    });
    const rendered = render('/workdir/report.md');

    const button = rendered.document.querySelector('.agent-tool-file-insert');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-label')).toBe(labels.insertIntoOutliner);

    await click(rendered, button);
    expect(requested).toEqual(['/workdir/report.md']);
  });

  test('confirms with the inserted label after a successful insert', async () => {
    detachBridge = onInsertFileIntoOutlinerRequest(async () => true);
    const rendered = render('/workdir/report.md');
    const button = rendered.document.querySelector('.agent-tool-file-insert');

    await click(rendered, button);
    expect(button?.getAttribute('aria-label')).toBe(labels.insertedIntoOutliner);
  });

  test('stays un-confirmed when nothing was inserted (file gone / out of root)', async () => {
    detachBridge = onInsertFileIntoOutlinerRequest(async () => false);
    const rendered = render('/workdir/gone.md');
    const button = rendered.document.querySelector('.agent-tool-file-insert');

    await click(rendered, button);
    // No false confirmation — the label stays actionable.
    expect(button?.getAttribute('aria-label')).toBe(labels.insertIntoOutliner);
  });

  test('stays un-confirmed when the bridge throws', async () => {
    detachBridge = onInsertFileIntoOutlinerRequest(async () => {
      throw new Error('ingest failed');
    });
    const rendered = render('/workdir/report.md');
    const button = rendered.document.querySelector('.agent-tool-file-insert');

    await click(rendered, button);
    // Back to the actionable label, not the confirmation — the user can retry.
    expect(button?.getAttribute('aria-label')).toBe(labels.insertIntoOutliner);
  });
});

function render(path: string): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(<InsertIntoOutlinerButton path={path} />);
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
  mounted.push(rendered);
  return rendered;
}

async function click(rendered: Rendered, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
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

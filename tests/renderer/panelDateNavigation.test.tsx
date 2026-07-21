import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TAG_DAY_ID, type NodeId, type NodeProjection } from '../../src/core/types';
import { buildDayNoteCountIndex } from '../../src/renderer/state/dayNoteCounts';
import { PanelDateNavigation } from '../../src/renderer/ui/PanelDateNavigation';

interface Rendered {
  cleanup: () => void;
  container: HTMLElement;
  document: Document;
  root: Root;
  window: Window;
}

const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('PanelDateNavigation', () => {
  test('uses the maintained visible date-count window for density and labels', async () => {
    const rendered = renderDateNavigation();

    await click(rendered, button(rendered, 'Open calendar'));

    const countedDay = button(rendered, 'Go to 2026-05-20 · 4 nodes');
    expect(countedDay.className).toContain('has-note-count');
    expect(countedDay.className).toContain('note-density-2');
    expect(button(rendered, 'Go to 2026-05-21').className).not.toContain('has-note-count');
  });
});

function renderDateNavigation(): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const dayNoteCounts = buildDayNoteCountIndex(new Map<NodeId, NodeProjection>([
    [TAG_DAY_ID, node(TAG_DAY_ID, 'day', { type: 'tagDef' })],
    ['day', node('day', '2026-05-20', { tags: [TAG_DAY_ID], children: ['a', 'b', 'c', 'd'] })],
  ]));

  act(() => {
    root.render(
      <PanelDateNavigation
        dayNoteCounts={dayNoteCounts}
        isoDate="2026-05-20"
        onRoot={() => undefined}
        run={async () => ({})}
      />,
    );
  });

  const rendered = {
    cleanup: () => {
      act(() => root.unmount());
    },
    container,
    document,
    root,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

function node(id: NodeId, text: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
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

async function click(rendered: Rendered, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

function button(rendered: Rendered, ariaLabel: string): HTMLButtonElement {
  const found = rendered.document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`);
  if (!found) throw new Error(`Missing button: ${ariaLabel}`);
  return found;
}

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TrailingReferencePopover } from '../../src/renderer/ui/outliner/TrailingReferencePopover';
import type { DocumentIndex } from '../../src/renderer/state/document';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';

interface Rendered {
  cleanup: () => void;
  picks: NodeId[];
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

// TrailingReferencePopover is the node-search overlay for a reference field-value
// draft: it searches the whole document by the typed query and, on pick, emits the
// chosen node id (the row appends a reference to it). It never offers a "create"
// affordance — a reference points at an existing node.
describe('TrailingReferencePopover', () => {
  test('filters document nodes by the typed query', () => {
    const rendered = render('al');
    expect(optionLabels(rendered)).toEqual(['Alpha']);
  });

  test('lists every content node for an empty query, excluding the field entry', () => {
    const rendered = render('');
    expect(optionLabels(rendered).sort()).toEqual(['Alpha', 'Beta task', 'Gamma']);
  });

  test('clicking a candidate emits its node id', async () => {
    const rendered = render('be');
    await click(rendered, option(rendered, 'Beta task'));
    expect(rendered.picks).toEqual(['beta']);
  });

  test('Enter picks the highlighted candidate', async () => {
    const rendered = render('gam');
    await keydown(rendered, 'Enter');
    expect(rendered.picks).toEqual(['gamma']);
  });

  test('Enter on an empty result set is a swallowed no-op', async () => {
    const rendered = render('zzz-no-match');
    expect(optionLabels(rendered)).toEqual([]);
    await keydown(rendered, 'Enter');
    expect(rendered.picks).toEqual([]);
  });
});

function render(query: string): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');

  const picks: NodeId[] = [];
  const root = createRoot(container);

  act(() => {
    root.render(
      <TrailingReferencePopover
        anchorRef={{ current: container }}
        index={index()}
        entryId="entry"
        open
        query={query}
        onOpenChange={() => {}}
        onPick={(targetId) => picks.push(targetId)}
      />,
    );
  });

  const rendered: Rendered = {
    cleanup: () => act(() => root.unmount()),
    picks,
    document,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

function index(): DocumentIndex {
  const nodes: NodeProjection[] = [
    makeNode('entry', 'fieldEntry', '', 'lib'),
    makeNode('alpha', undefined, 'Alpha', 'lib'),
    makeNode('beta', undefined, 'Beta task', 'lib'),
    makeNode('gamma', undefined, 'Gamma', 'lib'),
  ];
  const byId = new Map<NodeId, NodeProjection>(nodes.map((node) => [node.id, node]));
  return {
    projection: { nodes, libraryId: 'lib', trashId: 'trash' } as DocumentIndex['projection'],
    byId,
  } as DocumentIndex;
}

function makeNode(
  id: NodeId,
  type: NodeProjection['type'],
  text: string,
  parentId: NodeId | null,
): NodeProjection {
  return {
    id,
    type,
    parentId,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
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

function optionLabels(rendered: Rendered): string[] {
  return Array.from(rendered.document.querySelectorAll('[role="option"]'))
    .map((el) => el.querySelector('.popover-item-label')?.textContent?.trim() ?? '')
    .filter(Boolean);
}

function option(rendered: Rendered, label: string): Element {
  const found = Array.from(rendered.document.querySelectorAll('[role="option"]'))
    .find((el) => el.querySelector('.popover-item-label')?.textContent?.trim() === label);
  if (!found) throw new Error(`Missing option: ${label}`);
  return found;
}

async function click(rendered: Rendered, element: Element) {
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

async function keydown(rendered: Rendered, key: string) {
  // linkedom has no KeyboardEvent constructor; the popover's handler only reads
  // `key` + modifier flags, so a plain Event carrying `key` is sufficient.
  const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(event, { key });
  await act(async () => {
    rendered.window.dispatchEvent(event);
  });
}

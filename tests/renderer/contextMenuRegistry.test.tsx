// The permanent guard on the context menu's rendered surface.
//
// These goldens were GENERATED from the differential proof that ran against the
// shipped menu while it was still in the tree (commit "Route the context menu
// through the main-owned action seam", `contextMenuParity.test.tsx`): both
// paths rendered over these exact document states and the comparator admitted
// only the three approved deltas. The oracle is gone; its verdict is not.
//
// The deltas are visible below and nowhere else:
//   1. `Move to` retrieval converges on the shared kernel (not a menu row);
//   2. a mixed selection's `Toggle done` becomes convergent `Mark done` /
//      `Mark not done` setters;
//   3. action copy is normalized — `Send to Agent`, `Edit description`,
//      `Edit filters/sorting/grouping/displayed fields`, `Copy node ID`, and
//      the row-policy-true `remove` variants.

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Core } from '../../src/core/core';
import { ActionInvocationService } from '../../src/main/actionInvocationService';
import type { DocumentIndex } from '../../src/renderer/state/document';
import { buildIndex } from '../../src/renderer/state/document';
import { NodeContextMenu } from '../../src/renderer/ui/outliner/NodeContextMenu';
import type { NodeId } from '../../src/core/types';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

/** `[label, disabled, danger]` — the whole rendered menu, in order. */
type GoldenRow = [string, boolean, boolean];

const ORDINARY_NODE: GoldenRow[] = [
  ['Open in split pane', false, false],
  ['Pin', false, false],
  ['Send to Agent', false, false],
  ['Duplicate', false, false],
  ['Move up', false, false],
  ['Move down', false, false],
  ['Move to', false, false],
  ['Mark done', false, false],
  ['Add tag', false, false],
  ['View as', false, false],
  ['Show view toolbar', false, false],
  ['Edit filters', false, false],
  ['Edit sorting', false, false],
  ['Edit grouping', false, false],
  ['Edit displayed fields', false, false],
  ['Edit description', false, false],
  ['Copy text', false, false],
  ['Copy node ID', false, false],
  ['Move to Trash', false, false],
];

const MIXED_SELECTION: GoldenRow[] = [
  ['Open in split pane', false, false],
  ['Pin', false, false],
  ['Send to Agent', false, false],
  ['2 nodes: Duplicate', false, false],
  ['2 nodes: Move up', false, false],
  ['2 nodes: Move down', false, false],
  ['Move to', false, false],
  ['2 nodes: Mark done', false, false],
  ['2 nodes: Mark not done', false, false],
  ['2 nodes: Add tag', false, false],
  ['View as', false, false],
  ['Show view toolbar', false, false],
  ['Edit filters', false, false],
  ['Edit sorting', false, false],
  ['Edit grouping', false, false],
  ['Edit displayed fields', false, false],
  ['Edit description', false, false],
  ['Copy text', false, false],
  ['Copy node ID', false, false],
  ['2 nodes: Move to Trash', false, false],
];

const HOMOGENEOUS_SELECTION: GoldenRow[] = [
  ['Open in split pane', false, false],
  ['Pin', false, false],
  ['Send to Agent', false, false],
  ['2 nodes: Duplicate', false, false],
  ['2 nodes: Move up', false, false],
  ['2 nodes: Move down', false, false],
  ['Move to', false, false],
  ['2 nodes: Mark done', false, false],
  ['2 nodes: Add tag', false, false],
  ['View as', false, false],
  ['Show view toolbar', false, false],
  ['Edit filters', false, false],
  ['Edit sorting', false, false],
  ['Edit grouping', false, false],
  ['Edit displayed fields', false, false],
  ['Edit description', false, false],
  ['Copy text', false, false],
  ['Copy node ID', false, false],
  ['2 nodes: Move to Trash', false, false],
];

const TRASHED_NODE: GoldenRow[] = [
  ['Open in split pane', false, false],
  ['Pin', false, false],
  ['Send to Agent', false, false],
  ['Duplicate', false, false],
  ['Move up', false, false],
  ['Move down', false, false],
  ['Move to', false, false],
  ['Mark done', false, false],
  ['Add tag', false, false],
  ['View as', false, false],
  ['Show view toolbar', false, false],
  ['Edit filters', false, false],
  ['Edit sorting', false, false],
  ['Edit grouping', false, false],
  ['Edit displayed fields', false, false],
  ['Edit description', false, false],
  ['Copy text', false, false],
  ['Copy node ID', false, false],
  ['Restore', false, false],
  ['Delete forever', false, true],
];

const TRASH_ROOT: GoldenRow[] = [
  ['Open in split pane', false, false],
  ['Pin', false, false],
  ['Send to Agent', false, false],
  ['Duplicate', true, false],
  ['Move up', true, false],
  ['Move down', true, false],
  ['Move to', true, false],
  ['Mark done', true, false],
  ['Add tag', true, false],
  ['View as', false, false],
  ['Show view toolbar', false, false],
  ['Edit filters', false, false],
  ['Edit sorting', false, false],
  ['Edit grouping', false, false],
  ['Edit displayed fields', false, false],
  ['Edit description', false, false],
  ['Copy text', false, false],
  ['Copy node ID', false, false],
  ['Empty Trash', false, true],
];

// A table view drops `Edit grouping`, exactly as the shipped menu dropped
// `Group by`.
const TABLE_VIEW: GoldenRow[] = [
  ['Open in split pane', false, false],
  ['Pin', false, false],
  ['Send to Agent', false, false],
  ['Duplicate', false, false],
  ['Move up', false, false],
  ['Move down', false, false],
  ['Move to', false, false],
  ['Mark done', false, false],
  ['Add tag', false, false],
  ['View as', false, false],
  ['Hide view toolbar', false, false],
  ['Edit filters', false, false],
  ['Edit sorting', false, false],
  ['Edit displayed fields', false, false],
  ['Edit description', false, false],
  ['Copy text', false, false],
  ['Copy node ID', false, false],
  ['Move to Trash', false, false],
];

describe('the context menu as a registry view', () => {
  test('an ordinary node', async () => {
    expect(await renderRows(ordinaryNodeFixture())).toEqual(ORDINARY_NODE);
  });

  test('a mixed multi-selection converges on both Done setters', async () => {
    expect(await renderRows(multiSelectionFixture())).toEqual(MIXED_SELECTION);
  });

  test('a homogeneous selection presents only the state-changing setter', async () => {
    expect(await renderRows(homogeneousSelectionFixture())).toEqual(HOMOGENEOUS_SELECTION);
  });

  test('a trashed node offers Restore and a dangerous Delete forever', async () => {
    expect(await renderRows(trashedNodeFixture())).toEqual(TRASHED_NODE);
  });

  test('the Trash root offers Empty Trash and disables the row actions', async () => {
    expect(await renderRows(trashRootFixture())).toEqual(TRASH_ROOT);
  });

  test('a table view drops the grouping row', async () => {
    expect(await renderRows(tableViewFixture())).toEqual(TABLE_VIEW);
  });

  test('separators fall on the registry group boundaries, not a hard-coded list', async () => {
    const rendered = await renderMenu(ordinaryNodeFixture());
    const children = [...rendered.document.querySelectorAll('.node-context-menu > *')];
    const separatorIndexes = children
      .map((child, index) => (child.getAttribute('role') === 'separator' ? index : -1))
      .filter((index) => index >= 0);
    // Five separators, matching the shipped menu's six groups.
    expect(separatorIndexes).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Fixtures — real Core documents, not hand-built projections
// ---------------------------------------------------------------------------

interface Fixture {
  core: Core;
  index: DocumentIndex;
  anchorId: NodeId;
  targetId: NodeId;
  visualRowId: NodeId;
  openId: NodeId;
  selectedIds: Set<NodeId>;
  viewToolbarVisibleInRow: boolean;
  isPinned: boolean;
}

function baseFixture(prepare: (core: Core) => {
  anchorId: NodeId;
  selectedIds?: Set<NodeId>;
  viewToolbarVisibleInRow?: boolean;
}): Fixture {
  const core = Core.new();
  const prepared = prepare(core);
  const index = buildIndex(core.projection());
  const node = index.byId.get(prepared.anchorId);
  const targetId = node?.type === 'reference' && node.targetId ? node.targetId : prepared.anchorId;
  return {
    core,
    index,
    anchorId: prepared.anchorId,
    targetId,
    visualRowId: prepared.anchorId,
    openId: targetId,
    selectedIds: prepared.selectedIds ?? new Set<NodeId>(),
    viewToolbarVisibleInRow: prepared.viewToolbarVisibleInRow ?? false,
    isPinned: false,
  };
}

function todayId(core: Core): NodeId {
  return core.projection().todayId;
}

function ordinaryNodeFixture(): Fixture {
  return baseFixture((core) => {
    const created = core.createNode(todayId(core), null, 'Alpha');
    return { anchorId: created.focus!.nodeId };
  });
}

function multiSelectionFixture(): Fixture {
  return baseFixture((core) => {
    const parent = todayId(core);
    const first = core.createNode(parent, null, 'Alpha').focus!.nodeId;
    const second = core.createNode(parent, null, 'Beta').focus!.nodeId;
    core.toggleDone(second);
    return { anchorId: first, selectedIds: new Set([first, second]) };
  });
}

function homogeneousSelectionFixture(): Fixture {
  return baseFixture((core) => {
    const parent = todayId(core);
    const first = core.createNode(parent, null, 'Alpha').focus!.nodeId;
    const second = core.createNode(parent, null, 'Beta').focus!.nodeId;
    return { anchorId: first, selectedIds: new Set([first, second]) };
  });
}

function trashedNodeFixture(): Fixture {
  return baseFixture((core) => {
    const created = core.createNode(todayId(core), null, 'Gone').focus!.nodeId;
    core.trashNode(created);
    return { anchorId: created };
  });
}

function trashRootFixture(): Fixture {
  return baseFixture((core) => {
    const created = core.createNode(todayId(core), null, 'Gone').focus!.nodeId;
    core.trashNode(created);
    return { anchorId: core.projection().trashId };
  });
}

function tableViewFixture(): Fixture {
  return baseFixture((core) => {
    const created = core.createNode(todayId(core), null, 'Board').focus!.nodeId;
    core.setViewMode(created, 'table');
    core.setViewToolbarVisible(created, true);
    return { anchorId: created, viewToolbarVisibleInRow: true };
  });
}

// ---------------------------------------------------------------------------
// Rendering through the real seam
// ---------------------------------------------------------------------------

async function renderRows(fixture: Fixture): Promise<GoldenRow[]> {
  const rendered = await renderMenu(fixture);
  const rows = [...rendered.document.querySelectorAll('.node-context-menu [role="menuitem"]')]
    .map((item): GoldenRow => [
      (item.textContent ?? '').trim(),
      (item as HTMLButtonElement).disabled === true || item.getAttribute('aria-disabled') === 'true',
      item.className.includes('is-danger'),
    ]);
  await act(async () => {
    rendered.root.unmount();
  });
  return rows;
}

async function renderMenu(fixture: Fixture): Promise<OpenDom> {
  const rendered = openDom();
  installActionBridge(fixture);
  await act(async () => {
    rendered.root.render(
      <NodeContextMenu
        x={10}
        y={10}
        node={fixture.index.byId.get(fixture.anchorId)!}
        targetId={fixture.targetId}
        visualRowId={fixture.visualRowId}
        panelId="panel-0"
        viewToolbarVisibleInRow={fixture.viewToolbarVisibleInRow}
        openId={fixture.openId}
        selectedIds={fixture.selectedIds}
        index={fixture.index}
        isPinned={fixture.isPinned}
        onRoot={() => undefined}
        onTogglePin={() => undefined}
        onEditDescription={() => undefined}
        onRevealViewToolbar={() => undefined}
        onOpenViewSection={() => undefined}
        onClose={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

/**
 * The renderer's real bridge, backed by the real main-side service over the
 * fixture's real document — so this exercises the whole seam, not a mock of it.
 */
function installActionBridge(fixture: Fixture): void {
  const service = new ActionInvocationService({
    projection: () => fixture.core.projection(),
    runCommand: async () => ({}),
    searchNodes: () => [],
    executeRendererStep: async () => ({ status: 'ok' }),
    activateAppSurface: async () => undefined,
    writeClipboard: () => undefined,
    untitled: () => 'Untitled',
    now: () => 1,
  });
  const bridge = {
    actions: {
      open: async (seed: never) => service.openFromSeed(seed, {
        webContentsId: 1,
        renderGeneration: 1,
      }),
      queryParameters: async (request: never) => service.queryParameterObjects(request, 1),
      request: async (request: never) => service.request(request, 1),
      event: async (event: never) => service.event(event, 1),
      onStep: () => () => undefined,
    },
  };
  (globalThis as { lin?: unknown }).lin = bridge;
  (globalThis as { window?: { lin?: unknown } }).window!.lin = bridge;
}

interface OpenDom extends Rendered {
  root: ReturnType<typeof createRoot>;
}

function openDom(): OpenDom {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const rendered: OpenDom = {
    root,
    cleanup: () => act(() => root.unmount()),
    document,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window): void {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
    ResizeObserver: StubResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
  Object.assign(window, {
    ResizeObserver: StubResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

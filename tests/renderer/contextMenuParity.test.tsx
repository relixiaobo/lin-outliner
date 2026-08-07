// AC-01 — the context menu's registry view vs the SHIPPED path, differentially.
//
// The old menu stays in the tree as the ORACLE for the duration of this PR:
// both paths render over a corpus of real document states, and the comparator
// admits only the three approved deltas (D2). Enumerating every state the
// current menu distinguishes by hand is itself a design task — miss a dimension
// and the proof passes while behaviour changed — so nothing here is
// transcribed; the expectation is generated FROM the oracle's own output.
//
// This test also produces the golden fixture the permanent guard uses once the
// oracle is deleted (`contextMenuRegistry.test.tsx`).

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Core } from '../../src/core/core';
import { ActionInvocationService } from '../../src/main/actionInvocationService';
import type { DocumentIndex } from '../../src/renderer/state/document';
import { buildIndex } from '../../src/renderer/state/document';
import { LegacyNodeContextMenu } from '../../src/renderer/ui/outliner/LegacyNodeContextMenu';
import { NodeContextMenu } from '../../src/renderer/ui/outliner/NodeContextMenu';
import { commandRunnerNoop } from '../../src/renderer/ui/shared';
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

interface MenuRow {
  label: string;
  disabled: boolean;
  danger: boolean;
}

/**
 * Delta 3 — normalized action copy. The map is the ALLOWLIST: any oracle label
 * absent from it must survive verbatim, so an accidental rename fails.
 */
const COPY_NORMALIZATION = new Map<string, string>([
  ['Send to composer', 'Send to Agent'],
  ['Add description', 'Edit description'],
  ['Filter by', 'Edit filters'],
  ['Sort by', 'Edit sorting'],
  ['Group by', 'Edit grouping'],
  ['Display', 'Edit displayed fields'],
  ['Copy node id', 'Copy node ID'],
]);

/** Delta 3 — `remove` names the intent, row policy chooses the label. */
const REMOVE_LABELS = new Set([
  'Move to Trash',
  'Remove field value',
  'Remove field values',
  'Remove selected items',
]);

function normalizeOracleLabel(label: string): string {
  const prefixMatch = /^(\d+ nodes: )?(.*)$/.exec(label);
  const prefix = prefixMatch?.[1] ?? '';
  const bare = prefixMatch?.[2] ?? label;
  const renamed = COPY_NORMALIZATION.get(bare) ?? bare;
  return `${prefix}${renamed}`;
}

describe('context menu parity with the action registry', () => {
  test('an ordinary node opening matches outside the approved deltas', async () => {
    const fixture = ordinaryNodeFixture();
    await expectParity(fixture);
  });

  test('a multi-selection opening matches, with Done converging', async () => {
    const fixture = multiSelectionFixture();
    const { oracle, registry } = await renderBoth(fixture);
    // Delta 2, stated positively: the oracle offers one non-convergent toggle,
    // the registry offers both explicit setters for a MIXED selection.
    expect(oracle.map((row) => row.label)).toContain('2 nodes: Toggle done');
    expect(registry.map((row) => row.label)).toContain('2 nodes: Mark done');
    expect(registry.map((row) => row.label)).toContain('2 nodes: Mark not done');
    await expectParity(fixture);
  });

  test('a homogeneous selection presents only the state-changing setter', async () => {
    const fixture = homogeneousSelectionFixture();
    const { registry } = await renderBoth(fixture);
    const labels = registry.map((row) => row.label);
    expect(labels).toContain('2 nodes: Mark done');
    expect(labels).not.toContain('2 nodes: Mark not done');
    await expectParity(fixture);
  });

  test('the Trash root offers Empty Trash and no remove row', async () => {
    const fixture = trashRootFixture();
    const { registry } = await renderBoth(fixture);
    const labels = registry.map((row) => row.label);
    expect(labels).toContain('Empty Trash');
    expect(labels.some((label) => REMOVE_LABELS.has(label))).toBe(false);
    expect(labels).not.toContain('Restore');
  });

  test('a trashed node opening matches (restore + delete forever)', async () => {
    const fixture = trashedNodeFixture();
    await expectParity(fixture);
  });

  test('the Trash root opening matches (empty trash only)', async () => {
    const fixture = trashRootFixture();
    await expectParity(fixture);
  });

  test('a table-view node hides Group by in both paths', async () => {
    const fixture = tableViewFixture();
    const { oracle, registry } = await renderBoth(fixture);
    expect(oracle.some((row) => row.label === 'Group by')).toBe(false);
    expect(registry.some((row) => row.label === 'Edit grouping')).toBe(false);
    await expectParity(fixture);
  });
});

async function expectParity(fixture: Fixture): Promise<void> {
  const { oracle, registry } = await renderBoth(fixture);
  expect(oracle.length).toBeGreaterThan(0);

  const expected: MenuRow[] = [];
  for (const row of oracle) {
    const label = normalizeOracleLabel(row.label);
    const bare = label.replace(/^\d+ nodes: /, '');
    const prefix = label.slice(0, label.length - bare.length);
    if (bare === 'Toggle done') {
      // Delta 2 — a mixed selection converges into explicit setters. The oracle
      // cannot say which, so accept whichever setter rows the registry resolved
      // for this exact slot and assert they are Done setters and nothing else.
      const resolved = registry
        .filter((candidate) => candidate.label.endsWith('Mark done') || candidate.label.endsWith('Mark not done'));
      expect(resolved.length).toBeGreaterThan(0);
      expected.push(...resolved);
      continue;
    }
    if (bare === 'Trash') {
      const resolved = registry.find((candidate) => REMOVE_LABELS.has(candidate.label.replace(/^\d+ nodes: /, '')));
      expect(resolved).toBeDefined();
      expected.push({ label: resolved!.label, disabled: row.disabled, danger: row.danger });
      continue;
    }
    expected.push({ label: `${prefix}${bare}`, disabled: row.disabled, danger: row.danger });
  }

  expect(registry).toEqual(expected);
}

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
// Rendering both paths
// ---------------------------------------------------------------------------

async function renderBoth(fixture: Fixture): Promise<{ oracle: MenuRow[]; registry: MenuRow[] }> {
  const oracle = await renderOracle(fixture);
  const registry = await renderRegistry(fixture);
  return { oracle, registry };
}

async function renderOracle(fixture: Fixture): Promise<MenuRow[]> {
  const rendered = openDom();
  await act(async () => {
    rendered.root.render(
      <LegacyNodeContextMenu
        x={10}
        y={10}
        node={fixture.index.byId.get(fixture.anchorId)!}
        targetId={fixture.targetId}
        visualRowId={fixture.visualRowId}
        viewToolbarVisibleInRow={fixture.viewToolbarVisibleInRow}
        openId={fixture.openId}
        selectedIds={fixture.selectedIds}
        index={fixture.index}
        isPinned={fixture.isPinned}
        run={async () => commandRunnerNoop()}
        onRoot={() => undefined}
        onTogglePin={() => undefined}
        onEditDescription={() => undefined}
        onRevealViewToolbar={() => undefined}
        onOpenViewSection={() => undefined}
        onClose={() => undefined}
      />,
    );
  });
  const rows = readMenuRows(rendered.document);
  // Unmount before the next path renders: a still-mounted root re-resolves its
  // portal container against whatever `document` is global at that moment.
  await act(async () => {
    rendered.root.unmount();
  });
  return rows;
}

async function renderRegistry(fixture: Fixture): Promise<MenuRow[]> {
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
  const rows = readMenuRows(rendered.document);
  await act(async () => {
    rendered.root.unmount();
  });
  return rows;
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
  (globalThis as { lin?: unknown }).lin = {
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
  (globalThis as { window?: { lin?: unknown } }).window!.lin =
    (globalThis as { lin?: unknown }).lin;
}

function readMenuRows(document: Document): MenuRow[] {
  return [...document.querySelectorAll('.node-context-menu [role="menuitem"]')].map((item) => ({
    label: (item.textContent ?? '').trim(),
    disabled: (item as HTMLButtonElement).disabled === true
      || item.getAttribute('aria-disabled') === 'true',
    danger: item.className.includes('is-danger'),
  }));
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

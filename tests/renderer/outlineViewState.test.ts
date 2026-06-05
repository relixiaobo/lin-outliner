import { afterEach, describe, expect, test } from 'bun:test';
import type { NodeProjection } from '../../src/core/types';
import {
  persistOutlineViewState,
  restoreOutlineExpansionForRoot,
} from '../../src/renderer/state/outlineViewState';
import { hiddenFieldKey } from '../../src/renderer/state/outlinerRows';

const originalWindow = (globalThis as { window?: unknown }).window;
const STORAGE_KEY = 'lin-outliner:outline-view-state:v1';

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
    return;
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('outline view state', () => {
  test('restores saved expansion without clearing existing pane expansion', () => {
    const storage = installStorage();
    const rootId = 'root';
    const savedChildId = 'saved-child';
    const liveChildId = 'live-child';
    const otherChildId = 'other-child';
    const byId = new Map<string, NodeProjection>([
      [rootId, node(rootId, { children: [savedChildId, liveChildId] })],
      [savedChildId, node(savedChildId, { parentId: rootId })],
      [liveChildId, node(liveChildId, { parentId: rootId })],
      ['other-root', node('other-root', { children: [otherChildId] })],
      [otherChildId, node(otherChildId, { parentId: 'other-root' })],
    ]);
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      byRootNodeId: {
        [rootId]: {
          expandedNodeIds: [savedChildId],
          expandedHiddenFieldKeys: [],
          updatedAt: 1,
        },
      },
    }));

    const restored = restoreOutlineExpansionForRoot(
      rootId,
      byId,
      new Set([liveChildId, otherChildId]),
      new Set(),
    );

    expect(restored.expanded.has(rootId)).toBe(true);
    expect(restored.expanded.has(savedChildId)).toBe(true);
    expect(restored.expanded.has(liveChildId)).toBe(true);
    expect(restored.expanded.has(otherChildId)).toBe(true);
  });

  test('round-trips hidden field keys when node ids contain colons', () => {
    const storage = installStorage();
    const rootId = 'node:00000000-0000-4000-8000-000000000001';
    const fieldEntryId = 'field_entry:00000000-0000-4000-8000-000000000002';
    const key = hiddenFieldKey(rootId, fieldEntryId);
    const byId = new Map<string, NodeProjection>([
      [rootId, node(rootId, { children: [fieldEntryId] })],
      [fieldEntryId, node(fieldEntryId, {
        type: 'fieldEntry',
        parentId: rootId,
        fieldDefId: 'field:status',
      })],
    ]);

    persistOutlineViewState(rootId, byId, {
      expanded: new Set(),
      expandedHiddenFields: new Set([key]),
    });

    const restored = restoreOutlineExpansionForRoot(rootId, byId, new Set(), new Set());
    expect(storage.getItem(STORAGE_KEY)).toContain(key);
    expect(restored.expandedHiddenFields.has(key)).toBe(true);
  });

  test('keeps reference target subtrees outside the persisted root scope', () => {
    const storage = installStorage();
    const rootId = 'root';
    const referenceId = 'reference';
    const targetId = 'target';
    const targetChildId = 'target-child';
    const byId = new Map<string, NodeProjection>([
      [rootId, node(rootId, { children: [referenceId] })],
      [referenceId, node(referenceId, {
        type: 'reference',
        parentId: rootId,
        targetId,
      })],
      ['other-root', node('other-root', { children: [targetId] })],
      [targetId, node(targetId, { parentId: 'other-root', children: [targetChildId] })],
      [targetChildId, node(targetChildId, { parentId: targetId })],
    ]);

    persistOutlineViewState(rootId, byId, {
      expanded: new Set([rootId, referenceId, targetId, targetChildId]),
      expandedHiddenFields: new Set(),
    });

    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as {
      byRootNodeId?: Record<string, { expandedNodeIds?: string[] }>;
    };
    const expandedNodeIds = stored.byRootNodeId?.[rootId]?.expandedNodeIds ?? [];
    expect(expandedNodeIds).toContain(rootId);
    expect(expandedNodeIds).toContain(referenceId);
    expect(expandedNodeIds).not.toContain(targetId);
    expect(expandedNodeIds).not.toContain(targetChildId);

    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      byRootNodeId: {
        [rootId]: {
          expandedNodeIds: [referenceId, targetId, targetChildId],
          expandedHiddenFieldKeys: [],
          updatedAt: 1,
        },
      },
    }));
    const restored = restoreOutlineExpansionForRoot(rootId, byId, new Set(), new Set());
    expect(restored.expanded.has(referenceId)).toBe(true);
    expect(restored.expanded.has(targetId)).toBe(false);
    expect(restored.expanded.has(targetChildId)).toBe(false);
  });
});

function node(id: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text: '', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  });
  return storage;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

// The menu's own lifecycle contract, separate from what it renders.
//
// Every case here is a regression caught in review: each one passes silently
// against a plausible-looking implementation, and each one is a way the menu
// can lose an action, a failure, or its own handlers without saying so.

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Core } from '../../src/core/core';
import type {
  ActionRequestResult,
  InvocationOpened,
} from '../../src/core/actions/types';
import { buildIndex } from '../../src/renderer/state/document';
import {
  candidateForEnter,
  installActionErrorSink,
  registerActionStepHandlers,
  runActionStep,
} from '../../src/renderer/ui/interactions/actionSteps';
import { NodeContextMenu } from '../../src/renderer/ui/outliner/NodeContextMenu';
import type { NodeId } from '../../src/core/types';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface Harness {
  document: Document;
  root: ReturnType<typeof createRoot>;
  closes: number;
  errors: (string | null)[];
  requests: unknown[];
  pinCalls: NodeId[];
  render: (overrides?: { selectedIds?: Set<NodeId> }) => Promise<void>;
}

describe('context menu lifecycle', () => {
  test('a refused opening closes the surface instead of leaving it dead', async () => {
    const h = await harness({ open: async () => null });
    await h.render();
    expect(h.document.querySelector('.node-context-menu')).toBeNull();
    // Without this the owner's `contextMenu` state stays set and right-click is
    // dead until something else clears it.
    expect(h.closes).toBe(1);
  });

  test('a rejected open call also closes the surface', async () => {
    const h = await harness({ open: async () => { throw new Error('gone'); } });
    await h.render();
    expect(h.closes).toBe(1);
  });

  test('a failed action reports its reason instead of closing silently', async () => {
    const h = await harness({
      request: async (): Promise<ActionRequestResult> => ({
        status: 'failed',
        atStep: 0,
        reason: { kind: 'commandRejected', code: 'invalid move' },
      }),
    });
    await h.render();
    await clickMenuItem(h, 'Copy text');
    expect(h.errors).toEqual(['invalid move']);
    expect(h.closes).toBe(1);
  });

  test('a stale subject reports rather than looking like success', async () => {
    const h = await harness({
      request: async (): Promise<ActionRequestResult> => ({ status: 'stale', reason: 'subject' }),
    });
    await h.render();
    await clickMenuItem(h, 'Copy text');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeTruthy();
  });

  test('a completed action reports nothing at all, and clears nothing', async () => {
    // It used to clear, back when the error state was the outliner's own. The
    // notice is now app-wide, so clearing on success would delete a failure
    // raised somewhere else that the user may still be reading.
    const h = await harness({
      request: async (): Promise<ActionRequestResult> => ({ status: 'completed' }),
    });
    await h.render();
    await clickMenuItem(h, 'Copy text');
    expect(h.errors).toEqual([]);
  });
});

describe('renderer step handlers', () => {
  test('an explicit pin op does not degrade into a blind toggle', () => {
    const pinned = new Set<NodeId>(['already-pinned']);
    const toggles: NodeId[] = [];
    cleanups.push(registerActionStepHandlers('inv-1', {
      navigate: () => undefined,
      workspace: (op, nodeId) => {
        const isPinned = pinned.has(nodeId);
        if (op === 'pin' ? !isPinned : isPinned) toggles.push(nodeId);
      },
      reveal: () => undefined,
      composerHandoff: () => undefined,
    }));

    // `pin` on an already-pinned node must be a no-op, not an unpin.
    const ack = runActionStep({
      token: 't1',
      invocationRef: 'inv-1',
      step: { on: 'mainRenderer', kind: 'workspace', op: 'pin', nodeId: 'already-pinned' },
    });
    expect(ack.status).toBe('ok');
    expect(toggles).toEqual([]);

    runActionStep({
      token: 't2',
      invocationRef: 'inv-1',
      step: { on: 'mainRenderer', kind: 'workspace', op: 'pin', nodeId: 'not-pinned' },
    });
    expect(toggles).toEqual(['not-pinned']);
  });

  test('an unresolved bound node id fails the step instead of running it blind', () => {
    cleanups.push(registerActionStepHandlers('inv-2', {
      navigate: () => { throw new Error('should not run'); },
      workspace: () => undefined,
      reveal: () => undefined,
      composerHandoff: () => undefined,
    }));
    const ack = runActionStep({
      token: 't3',
      invocationRef: 'inv-2',
      step: {
        on: 'mainRenderer',
        kind: 'navigate',
        nodeId: { fromStep: 'today', field: 'focusNodeId' },
        inPlace: true,
      },
    });
    expect(ack.status).toBe('reported');
  });

  test('a step for an unknown invocation is reported, never silently dropped', () => {
    const ack = runActionStep({
      token: 't4',
      invocationRef: 'no-such-invocation',
      step: { on: 'mainRenderer', kind: 'workspace', op: 'unpin', nodeId: 'n1' },
    });
    expect(ack).toEqual({ token: 't4', status: 'reported', code: 'no-step-handler' });
  });
});

describe('the parameter picker', () => {
  test('Enter is swallowed while the candidate list belongs to older text', () => {
    const stale = { query: '', items: ['#blue', '#red'] };
    // The user typed `abc`; the list is still the one fetched for the empty
    // query. Committing it applied an unrelated existing tag.
    expect(candidateForEnter(stale, 'abc')).toBeNull();
  });

  test('Enter commits the top candidate once the list matches the query', () => {
    expect(candidateForEnter({ query: 'abc', items: ['abc-tag'] }, 'abc')).toBe('abc-tag');
  });

  test('an empty matching list commits nothing', () => {
    expect(candidateForEnter({ query: 'abc', items: [] }, 'abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

async function harness(bridge: {
  open?: () => Promise<InvocationOpened | null>;
  request?: (request: unknown) => Promise<ActionRequestResult>;
  queryParameters?: (request: unknown) => Promise<unknown>;
}): Promise<Harness> {
  const core = Core.new();
  const today = core.projection().todayId;
  const nodeId = core.createNode(today, null, 'Alpha').focus!.nodeId;
  const index = buildIndex(core.projection());

  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root')!;
  const root = createRoot(container);

  const state: Harness = {
    document,
    root,
    closes: 0,
    errors: [],
    requests: [],
    pinCalls: [],
    render: async () => undefined,
  };
  cleanups.push(installActionErrorSink((message) => state.errors.push(message)));
  cleanups.push(() => act(() => root.unmount()));

  const opened: InvocationOpened = {
    invocationRef: 'inv-live' as never,
    openSeq: null,
    fixedItems: [],
    resultItems: [],
    menuActions: [
      presentation('copy', 'Copy text', { representation: 'text' }),
      presentation('addTag', 'Add tag', undefined),
    ],
  };

  (globalThis as { window?: { lin?: unknown } }).window!.lin = {
    actions: {
      open: bridge.open ?? (async () => opened),
      request: bridge.request
        ? (async (request: unknown) => {
          state.requests.push(request);
          return bridge.request!(request);
        })
        : (async () => ({ status: 'completed' })),
      queryParameters: bridge.queryParameters ?? (async () => ({ status: 'superseded' })),
      event: async () => ({ status: 'spent' }),
      onStep: () => () => undefined,
    },
  };

  state.render = async () => {
    await act(async () => {
      root.render(
        <NodeContextMenu
          x={10}
          y={10}
          node={index.byId.get(nodeId)!}
          targetId={nodeId}
          visualRowId={nodeId}
          panelId="panel-0"
          viewToolbarVisibleInRow={false}
          openId={nodeId}
          selectedIds={new Set<NodeId>()}
          index={index}
          isPinned={false}
          isNodePinned={(id) => state.pinCalls.includes(id)}
          onRoot={() => undefined}
          onTogglePin={(id) => state.pinCalls.push(id)}
          onEditDescription={() => undefined}
          onRevealViewToolbar={() => undefined}
          onOpenViewSection={() => undefined}
          onClose={() => { state.closes += 1; }}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); });
  };
  return state;
}

function presentation(actionId: string, label: string, args: unknown) {
  return {
    actionId,
    subjectRef: 'subject-1',
    names: { en: label, 'zh-Hans': label },
    aliases: [],
    surfaces: ['contextMenu'],
    evaluation: { status: 'applicable' },
    binding: args === undefined
      ? {
        state: 'needsParameter',
        seed: {},
        parameter: {
          parameterId: 'tag',
          objectKinds: ['node', 'draft'],
          title: { en: 'Add tag', 'zh-Hans': 'Add tag' },
          inputLabel: { en: 'Tag name', 'zh-Hans': 'Tag name' },
          placeholder: { en: 'tag name', 'zh-Hans': 'tag name' },
        },
      }
      : { state: 'ready', arguments: args },
  } as never;
}

async function clickMenuItem(h: Harness, label: string): Promise<void> {
  const item = [...h.document.querySelectorAll('.node-context-menu [role="menuitem"]')]
    .find((element) => (element.textContent ?? '').trim() === label);
  if (!item) throw new Error(`No menu item: ${label}`);
  await act(async () => {
    item.dispatchEvent(new (h.document.defaultView as Window & typeof globalThis).Event('click', {
      bubbles: true,
      cancelable: true,
    }));
  });
  await act(async () => { await Promise.resolve(); });
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

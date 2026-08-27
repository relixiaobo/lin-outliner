import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { buildIndex, type DocumentIndex } from '../../src/renderer/state/document';
import { ReferenceSelector } from '../../src/renderer/ui/outliner/ReferenceSelector';
import type { CommandRunner } from '../../src/renderer/ui/shared';

const cleanups: Array<() => void> = [];
const BLOCKED_ID = 'node:11111111-1111-4111-8111-111111111111';
const SAFE_ID = 'node:22222222-2222-4222-8222-222222222222';

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('ReferenceSelector reachability transition', () => {
  test('keeps cold candidates inert without reordering or replacing the selected candidate', async () => {
    const index = buildIndex(referenceProjection());
    let closeCalls = 0;
    let runCalls = 0;
    const run: CommandRunner = async (operation) => {
      runCalls += 1;
      await operation();
      return null;
    };
    const rendered = renderSelector(index, run, () => { closeCalls += 1; });
    const initialNodes = candidateButtons(rendered.document);

    expect(initialNodes.map(candidateLabel)).toEqual([
      'Candidate beta',
      'Candidate safe',
    ]);
    expect(initialNodes.every((button) => button.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(rendered.document.querySelector('[data-selected="true"]')?.textContent)
      .toContain('Candidate safe');

    act(() => {
      initialNodes[0]!.dispatchEvent(new rendered.window.Event('click', {
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(closeCalls).toBe(0);
    expect(runCalls).toBe(0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const resolvedNodes = candidateButtons(rendered.document);
    expect(resolvedNodes.map(candidateLabel)).toEqual([
      'Candidate beta',
      'Candidate safe',
    ]);
    expect(resolvedNodes[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(resolvedNodes[1]!.getAttribute('aria-disabled')).toBeNull();
    expect(resolvedNodes[0]!.textContent).toContain('Would create a display cycle');
    expect(rendered.document.querySelector('[data-selected="true"]')?.textContent)
      .toContain('Candidate safe');
  });
});

function renderSelector(
  index: DocumentIndex,
  run: CommandRunner,
  close: () => void,
): { document: Document; window: Window } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { lin: unknown }).lin = { initialLanguage: 'en' };
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);

  function Harness() {
    const [selectedIndex, setSelectedIndex] = useState(1);
    return (
      <I18nProvider>
        <ReferenceSelector
          query="candidate"
          index={index}
          currentNodeId="current"
          treeReferenceParentId="parent"
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          run={run}
          close={close}
          clearTriggerText={async () => undefined}
        />
      </I18nProvider>
    );
  }

  act(() => { root.render(<Harness />); });
  cleanups.push(() => act(() => root.unmount()));
  return { document, window };
}

function candidateButtons(document: Document): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .filter((button) => button.getAttribute('data-create-reference') !== 'true');
}

function candidateLabel(button: HTMLButtonElement): string | null {
  return button.querySelector('.popover-item-label > span')?.textContent ?? null;
}

function referenceProjection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'root',
    nodes: [
      node('root', 'Root', { children: ['parent', BLOCKED_ID, SAFE_ID, 'trash'] }),
      node('parent', 'Parent', { parentId: 'root', children: ['current'] }),
      node('current', 'Editing', { parentId: 'parent' }),
      node(BLOCKED_ID, 'Candidate beta', {
        parentId: 'root',
        children: ['to-parent'],
        updatedAt: 100,
      }),
      node('to-parent', '', {
        type: 'reference',
        parentId: 'blocked',
        targetId: 'parent',
      }),
      node(SAFE_ID, 'Candidate safe', { parentId: 'root', updatedAt: 90 }),
      node('trash', 'Trash', { parentId: 'root' }),
    ],
  };
}

function node(id: string, text = id, patch: Partial<NodeProjection> = {}): NodeProjection {
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

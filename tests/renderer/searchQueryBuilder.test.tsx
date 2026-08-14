import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { SEARCH_QUERY_COMPLEXITY_LIMITS } from '../../src/core/searchQueryCompiler';
import type { NodeProjection } from '../../src/renderer/api/types';
import type { DocumentIndex } from '../../src/renderer/state/document';
import {
  SearchQueryBuilderPanel,
} from '../../src/renderer/ui/search/SearchQueryBuilderPanel';
import type { CommandRunner } from '../../src/renderer/ui/shared';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('SearchQueryBuilderPanel', () => {
  test('keeps a truncated query projection visible but unwritable', async () => {
    const ruleIds = Array.from(
      { length: SEARCH_QUERY_COMPLEXITY_LIMITS.maxChildrenPerGroup + 1 },
      (_, index) => `rule-${index}`,
    );
    const search = node('search', 'Large search', {
      type: 'search',
      children: ['group'],
    });
    const group = node('group', '', {
      type: 'queryCondition',
      parentId: 'search',
      queryLogic: 'AND',
      children: ruleIds,
    });
    const byId = new Map<string, NodeProjection>([
      ['search', search],
      ['group', group],
      ...ruleIds.map((id, index) => [id, node(id, `Term ${index}`, {
        type: 'queryCondition',
        parentId: 'group',
        queryOp: 'STRING_MATCH',
      })] as [string, NodeProjection]),
    ]);
    let runCalls = 0;
    const run: CommandRunner = async (operation) => {
      runCalls += 1;
      await operation();
      return null;
    };
    const rendered = render({ byId } as DocumentIndex, run);

    const warning = rendered.document.querySelector('[role="alert"]');
    expect(warning?.textContent).toContain('Some rules are omitted');
    const textarea = rendered.document.querySelector('textarea');
    expect(textarea?.getAttributeNames().some((name) => name.toLowerCase() === 'readonly')).toBe(true);
    expect(textarea?.getAttribute('aria-describedby')).toBe(warning?.id);
    const save = [...rendered.document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Save');
    expect(save?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      save?.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
    });
    expect(runCalls).toBe(0);
  });
});

function render(index: DocumentIndex, run: CommandRunner): {
  document: Document;
  window: Window;
} {
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
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <SearchQueryBuilderPanel
        index={index}
        nodeId="search"
        onClose={() => undefined}
        run={run}
      />,
    );
  });
  cleanups.push(() => act(() => root.unmount()));
  return { document, window };
}

function node(
  id: string,
  text: string,
  overrides: Record<string, unknown> = {},
): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...overrides,
  } as NodeProjection;
}

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { renderedMarkdownNodeReferenceIds } from '../../src/core/markdownNodeReferences';
import type { AgentFinalCitationBinding, ThreadReferenceView } from '../../src/core/agent/protocol';
import { ThreadMarkdown } from '../../src/renderer/agent/components/ThreadMarkdown';

const cleanups: Array<() => void> = [];
const NODE_ID = 'node:11111111-1111-4111-8111-111111111111';
const NODE_MARKER = '[[node://11111111-1111-4111-8111-111111111111]]';
const THREAD_ID = '01951d6e-7c25-7c31-8d62-313038616239';
const THREAD_MARKER = `[[thread://${THREAD_ID}]]`;

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('Thread Markdown references', () => {
  test('renders model-authored Thread markers with current resolver presentation', () => {
    let opened = '';
    const threadReferences = new Map<string, ThreadReferenceView>([[THREAD_ID, {
      threadId: THREAD_ID,
      title: 'Renamed chat',
      updatedAt: 200,
      availability: 'available',
    }]]);
    const document = renderThreadMarkdown(`Use ${THREAD_MARKER}`, {
      threadReferences,
      onThreadReferenceOpen: (threadId) => { opened = threadId; },
    });
    const reference = document.querySelector<HTMLElement>('[data-thread-ref]');
    expect(reference?.textContent).toBe('Renamed chat');
    reference?.click();
    expect(opened).toBe(THREAD_ID);
  });

  test('keeps escaped, code, current, and unavailable Thread markers non-fatal', () => {
    const threadReferences = new Map<string, ThreadReferenceView>([[THREAD_ID, {
      threadId: THREAD_ID,
      title: null,
      updatedAt: 200,
      availability: 'current',
    }]]);
    const document = renderThreadMarkdown([
      `\\${THREAD_MARKER}`,
      `\`${THREAD_MARKER}\``,
      THREAD_MARKER,
    ].join('\n\n'), { threadReferences });
    expect(document.querySelector('[data-thread-ref]')).toBeNull();
    expect(document.body.textContent).toContain('01951d6e...6239');
  });

  test('renders escaped and entity-normalized markers through the shared AST transform', () => {
    const document = renderThreadMarkdown([
      `\\${NODE_MARKER}`,
      `\\\\${NODE_MARKER}`,
      `\\\\\\${NODE_MARKER}`,
      '&#91;[node://11111111-1111-4111-8111-111111111111]]',
      `\`${NODE_MARKER}\``,
      `[Existing ${NODE_MARKER}](https://example.test)`,
    ].join('\n\n'));

    expect([...document.querySelectorAll('[data-inline-ref]')]
      .map((element) => element.getAttribute('data-inline-ref'))).toEqual([
      NODE_ID,
      NODE_ID,
    ]);
  });

  test('maps an entity-normalized marker before an escaped duplicate to its own source occurrence', () => {
    const markdown = `&#91;${NODE_MARKER.slice(1)} / \\${NODE_MARKER}`;

    expect(renderedMarkdownNodeReferenceIds(markdown)).toEqual([NODE_ID]);
    const document = renderThreadMarkdown(markdown);
    const references = [...document.querySelectorAll<HTMLElement>('[data-inline-ref]')];
    expect(references).toHaveLength(1);
    expect(references[0]!.dataset.inlineRef).toBe(NODE_ID);
    expect(document.body.textContent).toContain(NODE_MARKER);
  });

  test.each([512, 513])('renders a reference after %i normalized entities', (entityCount) => {
    const markdown = `${'&amp;'.repeat(entityCount)}${NODE_MARKER}`;

    expect(renderedMarkdownNodeReferenceIds(markdown)).toEqual([NODE_ID]);
    const document = renderThreadMarkdown(markdown);
    expect(document.querySelector(`[data-inline-ref="${NODE_ID}"]`)).not.toBeNull();
  });

  test('preserves document definitions when rendering reference-style links in blocks', () => {
    const markdown = [
      `[Existing ${NODE_MARKER}][reference-link]`,
      '[reference-link]: https://example.test',
    ].join('\n\n');

    expect(renderedMarkdownNodeReferenceIds(markdown)).toEqual([]);
    const document = renderThreadMarkdown(markdown);
    expect(document.querySelector(`[data-inline-ref="${NODE_ID}"]`)).toBeNull();
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.test');
  });

  test('projects an opaque final citation without treating the marker path as authority', () => {
    const resourceRef = {
      id: 'resource:11111111-1111-4111-8111-111111111111',
      mimeType: 'text/plain',
      byteLength: 12,
      fileName: 'report.txt',
    } as const;
    const finalCitations: readonly AgentFinalCitationBinding[] = [{
      markerOrdinal: 0,
      status: 'available',
      entryKind: 'file',
      resourceRef,
      openIntent: 'delivered',
      sourceAvailable: true,
      reason: null,
    }];
    const document = renderThreadMarkdown(
      'Delivered: [[file:///workspace/report.txt]]',
      { finalCitations, threadId: 'thread-1' },
    );
    const reference = document.querySelector<HTMLElement>('[data-inline-ref-kind="local-file"]');

    expect(reference?.dataset.inlineRefPath).toBe('/workspace/report.txt');
    expect(reference?.dataset.inlineRefThreadId).toBe('thread-1');
    expect(reference?.dataset.inlineRefResourceId).toBe(resourceRef.id);
    expect(reference?.dataset.inlineRefResourceFileName).toBe(resourceRef.fileName);
    expect(reference?.dataset.inlineRefResourceIntent).toBe('delivered');
    expect(reference?.dataset.inlineRefCitationStatus).toBe('available');
    expect(reference?.dataset.inlineRefSourceAvailable).toBe('true');
    expect(reference?.dataset.inlineRefReadonly).toBeUndefined();
  });

  test.each(['unavailable', 'denied'] as const)(
    'keeps a final citation in %s state bound and non-actionable instead of trusting its marker path',
    (status) => {
      const finalCitations: readonly AgentFinalCitationBinding[] = [{
        markerOrdinal: 0,
        status,
        entryKind: 'file',
        resourceRef: null,
        openIntent: null,
        sourceAvailable: false,
        reason: `${status} test`,
      }];
      const document = renderThreadMarkdown(
        'Missing: [[file:///workspace/private.txt]]',
        { finalCitations, threadId: 'thread-1' },
      );
      const reference = document.querySelector<HTMLElement>('[data-inline-ref-kind="local-file"]');

      expect(reference?.tagName).toBe('SPAN');
      expect(reference?.dataset.inlineRefCitationStatus).toBe(status);
      expect(reference?.dataset.inlineRefThreadId).toBe('thread-1');
      expect(reference?.dataset.inlineRefPath).toBeUndefined();
      expect(reference?.dataset.inlineRefResourceId).toBeUndefined();
      expect(reference?.dataset.inlineRefReadonly).toBe('true');
      expect(document.querySelector('a')).toBeNull();
    },
  );

  test('does not expose a bound citation path when its owning Thread identity is absent', () => {
    const finalCitations: readonly AgentFinalCitationBinding[] = [{
      markerOrdinal: 0,
      status: 'available',
      entryKind: 'file',
      resourceRef: {
        id: 'resource:22222222-2222-4222-8222-222222222222',
        mimeType: 'text/plain',
        byteLength: 4,
        fileName: 'bound.txt',
      },
      openIntent: 'delivered',
      sourceAvailable: true,
      reason: null,
    }];
    const document = renderThreadMarkdown('Bound: [[file:///workspace/bound.txt]]', { finalCitations });
    const reference = document.querySelector<HTMLElement>('[data-inline-ref-kind="local-file"]');

    expect(reference?.tagName).toBe('SPAN');
    expect(reference?.dataset.inlineRefCitationStatus).toBe('available');
    expect(reference?.dataset.inlineRefPath).toBeUndefined();
    expect(reference?.dataset.inlineRefReadonly).toBe('true');
  });
});

function renderThreadMarkdown(
  text: string,
  options: {
    readonly finalCitations?: readonly AgentFinalCitationBinding[];
    readonly onThreadReferenceOpen?: (threadId: string) => void;
    readonly threadId?: string;
    readonly threadReferences?: ReadonlyMap<string, ThreadReferenceView>;
  } = {},
): Document {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <ThreadMarkdown
        finalCitations={options.finalCitations}
        onNodeReferenceOpen={() => undefined}
        onThreadReferenceOpen={options.onThreadReferenceOpen}
        text={text}
        threadId={options.threadId}
        threadReferences={options.threadReferences}
      />,
    );
  });
  cleanups.push(() => act(() => root.unmount()));
  return document;
}

function installDomGlobals(window: Window): void {
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

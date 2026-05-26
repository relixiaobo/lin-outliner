import { afterEach, describe, expect, test } from 'bun:test';
import { Fragment, useEffect, useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { RichTextEditor } from '../../src/renderer/ui/editor/RichTextEditor';
import { EMPTY_RICH_TEXT } from '../../src/renderer/api/types';
import type { RichText } from '../../src/renderer/api/types';

// R1 spike: the Tana eager-materialization model hinges on the trailing draft
// row keeping its React identity when it becomes a real node, so the editor
// (and its imperative ProseMirror EditorView, created in a mount-only effect)
// is NOT torn down — which is what keeps an in-flight IME composition alive.
//
// This pins the *mechanism*: a row whose `key` is stable across a draft->real
// transition reuses the same component instance (mount effect runs once); a row
// whose `key` changes (the lazy create-returns-a-new-id path) remounts.

interface Rendered {
  root: Root;
  document: Document;
  cleanup: () => void;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

function setupDom() {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  return { document, root: createRoot(container) };
}

// Mimics RichTextEditor's lifecycle: an imperative "view" created once in a
// mount-only effect (deps []), torn down on unmount. We count creations to
// detect remounts, and tag the DOM so we can compare element identity.
const lifecycle = { created: 0, destroyed: 0 };

function EditorProbe(props: { rowId: string; text: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    lifecycle.created += 1;
    const view = { id: props.rowId };
    void view;
    return () => {
      lifecycle.destroyed += 1;
    };
    // deps [] on purpose: the view is created once per mount, like the real
    // EditorView (useMemo([]) initialState).
  }, []);
  return <div ref={mountRef} className="row-editor" data-text={props.text} />;
}

interface Row { id: string; text: string }

// Mirrors RowHost: keyed by row.id.
function RowList(props: { rows: Row[] }) {
  return (
    <>
      {props.rows.map((row) => (
        <Fragment key={row.id}>
          <EditorProbe rowId={row.id} text={row.text} />
        </Fragment>
      ))}
    </>
  );
}

describe('R1: editor identity across draft -> materialized transition', () => {
  test('stable id (client-supplied id) reuses the editor — no remount', () => {
    lifecycle.created = 0;
    lifecycle.destroyed = 0;
    const { document, root } = setupDom();
    mounted.push({ root, document, cleanup: () => act(() => root.unmount()) });

    const draftId = 'node:client-abc';

    // Draft row: renderer-only, no content yet.
    act(() => root.render(<RowList rows={[{ id: draftId, text: '' }]} />));
    const before = document.querySelector('.row-editor');
    expect(before).not.toBeNull();
    expect(lifecycle.created).toBe(1);

    // Materialize: same id (the draft already held its final id), now with text.
    act(() => root.render(<RowList rows={[{ id: draftId, text: '你' }]} />));
    const after = document.querySelector('.row-editor');

    // Same DOM element instance -> React reused the component -> the imperative
    // view (EditorView) was never recreated -> IME composition survives.
    expect(after).toBe(before);
    expect(after?.getAttribute('data-text')).toBe('你');
    expect(lifecycle.created).toBe(1); // not remounted
    expect(lifecycle.destroyed).toBe(0);
  });

  test('control: changing id (lazy create returns a new id) remounts the editor', () => {
    lifecycle.created = 0;
    lifecycle.destroyed = 0;
    const { document, root } = setupDom();
    mounted.push({ root, document, cleanup: () => act(() => root.unmount()) });

    // Draft under a temporary id, then "create" returns a different real id —
    // this is exactly what the current lazy path does, and why it remounts.
    act(() => root.render(<RowList rows={[{ id: 'draft:tmp', text: '' }]} />));
    const before = document.querySelector('.row-editor');
    expect(lifecycle.created).toBe(1);

    act(() => root.render(<RowList rows={[{ id: 'node:real-xyz', text: '你' }]} />));
    const after = document.querySelector('.row-editor');

    expect(after).not.toBe(before); // different element -> remounted
    expect(lifecycle.created).toBe(2);
    expect(lifecycle.destroyed).toBe(1);
  });
});

const noop = () => {};

function RealRowList(props: { rows: { id: string; content: RichText }[] }) {
  return (
    <>
      {props.rows.map((row) => (
        <Fragment key={row.id}>
          <RichTextEditor
            nodeId={row.id}
            content={row.content}
            onFocus={noop}
            onChange={noop}
            onPatch={noop}
            onCommit={noop}
            onEnter={noop}
            onBackspaceAtStart={noop}
            onTab={noop}
            onArrowUpAtStart={noop}
            onArrowDownAtEnd={noop}
            onModEnter={noop}
            onEscape={noop}
            onTriggerChange={noop}
          />
        </Fragment>
      ))}
    </>
  );
}

describe('R1 (real editor): ProseMirror EditorView survives the materialize content change', () => {
  test('stable id, content goes empty -> "你": the .ProseMirror element is preserved', () => {
    const { document, root } = setupDom();
    (globalThis.window.HTMLElement.prototype as { focus?: () => void }).focus = () => {};
    mounted.push({ root, document, cleanup: () => act(() => root.unmount()) });

    const id = 'node:client-abc';
    act(() => root.render(<RealRowList rows={[{ id, content: EMPTY_RICH_TEXT }]} />));
    const before = document.querySelector('.ProseMirror');
    expect(before).not.toBeNull();

    act(() => root.render(<RealRowList rows={[{ id, content: { ...EMPTY_RICH_TEXT, text: '你' } }]} />));
    const after = document.querySelector('.ProseMirror');

    // Same DOM node => the EditorView (created in a mount-only effect) was not
    // torn down and recreated; only its document was synced.
    expect(after).toBe(before);
  });
});

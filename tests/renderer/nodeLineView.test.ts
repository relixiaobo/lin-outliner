import { describe, expect, test } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';
import { richTextToDoc, docPosToTextOffset } from '../../src/renderer/ui/editor/richTextCodec';
import { selectionForPlacement, selectionTextOffsets } from '../../src/renderer/ui/editor/nodeLineView';
import type { RichText } from '../../src/renderer/api/types';
import type { CursorPlacement } from '../../src/renderer/state/document';

function doc(text: string, inlineRefs: RichText['inlineRefs'] = []) {
  return richTextToDoc({ text, marks: [], inlineRefs });
}

function place(text: string, placement: CursorPlacement) {
  return selectionForPlacement(doc(text), placement);
}

describe('selectionForPlacement (plain text — the model both node-line editors share)', () => {
  // "Hello": paragraph nodeSize = 7, doc.content.size = 7, so start=1, end=6.
  test('start anchors to position 1', () => {
    const sel = place('Hello', { kind: 'start' })!;
    expect([sel.from, sel.to]).toEqual([1, 1]);
  });

  test('end anchors past the last character (offset N -> pos 1+N)', () => {
    const sel = place('Hello', { kind: 'end' })!;
    expect([sel.from, sel.to]).toEqual([6, 6]);
  });

  test('all selects the whole line [1, size-1]', () => {
    const sel = place('Hello', { kind: 'all' })!;
    expect([sel.from, sel.to]).toEqual([1, 6]);
  });

  test('text-offset maps offset N to pos 1+N', () => {
    const sel = place('Hello', { kind: 'text-offset', offset: 2 })!;
    expect([sel.from, sel.to]).toEqual([3, 3]);
  });

  test('text-offset past the end clamps to size-1 (matches the old trailing-input formula)', () => {
    const sel = place('Hello', { kind: 'text-offset', offset: 99 })!;
    expect([sel.from, sel.to]).toEqual([6, 6]);
  });

  test('preserve returns null so the caller leaves the selection untouched', () => {
    expect(place('Hello', { kind: 'preserve' })).toBeNull();
  });
});

describe('selectionForPlacement (empty line)', () => {
  // empty paragraph: doc.content.size = 2, start=1, end=max(1, 1)=1.
  test('start / end / text-offset all collapse to position 1', () => {
    expect(place('', { kind: 'start' })!.from).toBe(1);
    expect(place('', { kind: 'end' })!.from).toBe(1);
    expect(place('', { kind: 'text-offset', offset: 0 })!.from).toBe(1);
  });

  test('all selects the empty range [1, 1]', () => {
    const sel = place('', { kind: 'all' })!;
    expect([sel.from, sel.to]).toEqual([1, 1]);
  });
});

describe('selectionForPlacement (inline references — bias is honored)', () => {
  test('text-offset at a reference offset places before vs. after the ref atom by bias', () => {
    const withRef = doc('ab', [{ offset: 1, targetNodeId: 'n1' }]);
    const before = selectionForPlacement(withRef, { kind: 'text-offset', offset: 1, inlineRefBias: 'before' })!;
    const after = selectionForPlacement(withRef, { kind: 'text-offset', offset: 1, inlineRefBias: 'after' })!;
    expect(before.from).toBeLessThan(after.from);
  });
});

describe('selectionTextOffsets', () => {
  function viewWith(text: string, from: number, to: number): EditorView {
    const d = doc(text);
    const state = EditorState.create({ schema: pmSchema, doc: d, selection: TextSelection.create(d, from, to) });
    return { state } as unknown as EditorView;
  }

  test('reports normalized [from, to] text offsets of the selection', () => {
    // doc pos 2..5 over "Hello" -> text offsets 1..4
    expect(selectionTextOffsets(viewWith('Hello', 2, 5))).toEqual({ from: 1, to: 4 });
  });

  test('normalizes a backward selection', () => {
    expect(selectionTextOffsets(viewWith('Hello', 5, 2))).toEqual({ from: 1, to: 4 });
  });

  test('round-trips with docPosToTextOffset at the caret', () => {
    const view = viewWith('Hello', 3, 3);
    const { from } = selectionTextOffsets(view);
    expect(from).toBe(docPosToTextOffset(view.state.doc, 3));
  });
});
